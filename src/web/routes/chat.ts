import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  addMessage,
  type ContentBlock,
  createConversation,
  getConversationForUser,
} from "../../lib/conversations.js";
import { getDb } from "../../lib/db.js";
import { collectPart } from "../../lib/format-tool.js";
import { readNdjson } from "../../lib/ndjson.js";
import { findAgent } from "../../lib/registry.js";
import { agentMessages } from "../../lib/schema.js";
import { findVariant } from "../../lib/variants.js";
import type { AuthEnv } from "../middleware/auth.js";

const chatSchema = z.object({
  message: z.string().optional(),
  conversationId: z.string().optional(),
  images: z
    .array(
      z.object({
        media_type: z.string(),
        data: z.string(),
      }),
    )
    .optional(),
});

const app = new Hono<AuthEnv>().post("/:name/chat", zValidator("json", chatSchema), async (c) => {
  const name = c.req.param("name");
  const [baseName, variantName] = name.split("@", 2);

  const entry = findAgent(baseName);
  if (!entry) return c.json({ error: "Agent not found" }, 404);

  let port = entry.port;
  if (variantName) {
    const variant = findVariant(baseName, variantName);
    if (!variant) return c.json({ error: `Unknown variant: ${variantName}` }, 404);
    port = variant.port;
  }

  const { getAgentManager } = await import("../../lib/agent-manager.js");
  if (!getAgentManager().isRunning(name)) {
    return c.json({ error: "Agent is not running" }, 409);
  }

  const body = c.req.valid("json");
  if (!body.message && (!body.images || body.images.length === 0)) {
    return c.json({ error: "message or images required" }, 400);
  }

  const user = c.get("user");

  // Resolve or create conversation
  let conversationId = body.conversationId;
  if (conversationId) {
    const conv = await getConversationForUser(conversationId, user.id);
    if (!conv) return c.json({ error: "Conversation not found" }, 404);
  } else {
    const title = body.message ? body.message.slice(0, 80) : "Image message";
    const conv = await createConversation(baseName, "web", {
      userId: user.id,
      title,
    });
    conversationId = conv.id;
  }

  // Build content blocks (used for both persistence and agent request)
  const contentBlocks: ContentBlock[] = [];
  if (body.message) {
    contentBlocks.push({ type: "text", text: body.message });
  }
  if (body.images) {
    for (const img of body.images) {
      contentBlocks.push({ type: "image", media_type: img.media_type, data: img.data });
    }
  }

  // Save user message
  await addMessage(conversationId, "user", user.username, contentBlocks);

  // Record in agent_messages
  const db = await getDb();
  await db.insert(agentMessages).values({
    agent: baseName,
    channel: "web",
    role: "user",
    sender: user.username,
    content: body.message ?? "[image]",
  });

  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: contentBlocks,
        channel: "web",
        sender: user.username,
      }),
    });
  } catch (err) {
    console.error(`[chat] agent ${name} unreachable on port ${port}:`, err);
    return c.json({ error: "Agent is not reachable" }, 502);
  }

  if (!res.ok) {
    return c.json({ error: `Agent responded with ${res.status}` }, res.status as 500);
  }

  if (!res.body) {
    return c.json({ error: "No response body from agent" }, 502);
  }

  return streamSSE(c, async (stream) => {
    // Send conversation ID as first event
    await stream.writeSSE({
      data: JSON.stringify({ type: "meta", conversationId }),
    });

    const assistantContent: ContentBlock[] = [];

    for await (const event of readNdjson(res.body!)) {
      await stream.writeSSE({ data: JSON.stringify(event) });

      if (event.type === "text") {
        // Merge consecutive text blocks
        const last = assistantContent[assistantContent.length - 1];
        if (last && last.type === "text") {
          last.text += event.content;
        } else {
          assistantContent.push({ type: "text", text: event.content });
        }
      } else if (event.type === "tool_use") {
        assistantContent.push({
          type: "tool_use",
          name: event.name,
          input: event.input,
        });
      } else if (event.type === "tool_result") {
        assistantContent.push({
          type: "tool_result",
          output: event.output,
          ...(event.is_error ? { is_error: true } : {}),
        });
      }

      if (event.type === "done") {
        // Save assistant message
        if (assistantContent.length > 0) {
          await addMessage(conversationId!, "assistant", baseName, assistantContent);

          // Record in agent_messages (text + tool summaries)
          const textParts: string[] = [];
          const toolParts: string[] = [];
          for (const b of assistantContent) {
            const part = collectPart(b);
            if (part != null) {
              if (b.type === "tool_use") toolParts.push(part);
              else textParts.push(part);
            }
          }
          const summary = [textParts.join(""), ...toolParts].filter(Boolean).join("\n");
          if (summary) {
            await db.insert(agentMessages).values({
              agent: baseName,
              channel: "web",
              role: "assistant",
              sender: baseName,
              content: summary,
            });
          }
        }
        break;
      }
    }
  });
});

export default app;
