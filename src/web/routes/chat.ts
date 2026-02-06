import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  addMessage,
  type ContentBlock,
  createConversation,
  getConversation,
} from "../../lib/conversations.js";
import { readNdjson } from "../../lib/ndjson.js";
import { findAgent } from "../../lib/registry.js";
import type { MoltContentPart, MoltEvent } from "../../types.js";
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

const app = new Hono<AuthEnv>();

app.post("/:name/chat", zValidator("json", chatSchema), async (c) => {
  const name = c.req.param("name");
  const entry = findAgent(name);
  if (!entry) return c.json({ error: "Agent not found" }, 404);

  const body = c.req.valid("json");
  if (!body.message && (!body.images || body.images.length === 0)) {
    return c.json({ error: "message or images required" }, 400);
  }

  const user = c.get("user");

  // Resolve or create conversation
  let conversationId = body.conversationId;
  if (conversationId) {
    const conv = await getConversation(conversationId);
    if (!conv) return c.json({ error: "Conversation not found" }, 404);
  } else {
    const title = body.message ? body.message.slice(0, 80) : "Image message";
    const conv = await createConversation(name, "web", {
      userId: user.id,
      title,
    });
    conversationId = conv.id;
  }

  // Build user content blocks
  const userContent: ContentBlock[] = [];
  if (body.message) {
    userContent.push({ type: "text", text: body.message });
  }
  if (body.images) {
    for (const img of body.images) {
      userContent.push({ type: "image", media_type: img.media_type, data: img.data });
    }
  }

  // Save user message
  await addMessage(conversationId, "user", user.username, userContent);

  // Build content for agent server
  const agentContent: MoltContentPart[] = [];
  if (body.message) {
    agentContent.push({ type: "text", text: body.message });
  }
  if (body.images) {
    for (const img of body.images) {
      agentContent.push({ type: "image", media_type: img.media_type, data: img.data });
    }
  }

  const res = await fetch(`http://localhost:${entry.port}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: agentContent,
      channel: "web",
      sender: user.username,
    }),
  });

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
      const moltEvent = event as MoltEvent;
      await stream.writeSSE({ data: JSON.stringify(moltEvent) });

      if (moltEvent.type === "text") {
        // Merge consecutive text blocks
        const last = assistantContent[assistantContent.length - 1];
        if (last && last.type === "text") {
          last.text += moltEvent.content;
        } else {
          assistantContent.push({ type: "text", text: moltEvent.content });
        }
      } else if (moltEvent.type === "tool_use") {
        assistantContent.push({ type: "tool_use", name: moltEvent.name, input: moltEvent.input });
      } else if (moltEvent.type === "tool_result") {
        assistantContent.push({
          type: "tool_result",
          output: moltEvent.output,
          ...(moltEvent.is_error ? { is_error: true } : {}),
        });
      }

      if (moltEvent.type === "done") {
        // Save assistant message
        if (assistantContent.length > 0) {
          await addMessage(conversationId!, "assistant", name, assistantContent);
        }
        break;
      }
    }
  });
});

export default app;
