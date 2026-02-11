import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { getOrCreateAgentUser } from "../../lib/auth.js";
import {
  addMessage,
  type ContentBlock,
  createConversation,
  getParticipants,
  isParticipantOrOwner,
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

/** Consume an agent's ndjson response and persist it as a conversation message. */
async function consumeAndPersist(
  res: Response,
  conversationId: string,
  agentName: string,
  channel: string,
): Promise<void> {
  if (!res.body) return;
  const assistantContent: ContentBlock[] = [];
  for await (const event of readNdjson(res.body)) {
    if (event.type === "text") {
      const last = assistantContent[assistantContent.length - 1];
      if (last && last.type === "text") last.text += event.content;
      else assistantContent.push({ type: "text", text: event.content });
    } else if (event.type === "tool_use") {
      assistantContent.push({ type: "tool_use", name: event.name, input: event.input });
    } else if (event.type === "tool_result") {
      assistantContent.push({
        type: "tool_result",
        output: event.output,
        ...(event.is_error ? { is_error: true } : {}),
      });
    }
    if (event.type === "done") break;
  }
  if (assistantContent.length > 0) {
    await addMessage(conversationId, "assistant", agentName, assistantContent);
    const db = await getDb();
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
        agent: agentName,
        channel,
        role: "assistant",
        sender: agentName,
        content: summary,
      });
    }
  }
}

const app = new Hono<AuthEnv>().post("/:name/chat", zValidator("json", chatSchema), async (c) => {
  const name = c.req.param("name");
  const [baseName, variantName] = name.split("@", 2);

  const entry = findAgent(baseName);
  if (!entry) return c.json({ error: "Agent not found" }, 404);

  if (variantName) {
    const variant = findVariant(baseName, variantName);
    if (!variant) return c.json({ error: `Unknown variant: ${variantName}` }, 404);
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
  const agentUser = await getOrCreateAgentUser(baseName);

  // Resolve or create conversation
  let conversationId = body.conversationId;
  if (conversationId) {
    if (!(await isParticipantOrOwner(conversationId, user.id))) {
      return c.json({ error: "Conversation not found" }, 404);
    }
  } else {
    const title = body.message ? body.message.slice(0, 80) : "Image message";
    const conv = await createConversation(baseName, "volute", {
      userId: user.id,
      title,
      participantIds: [user.id, agentUser.id],
    });
    conversationId = conv.id;
  }

  const channel = `volute:${conversationId}`;

  // Build content blocks
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
    channel,
    role: "user",
    sender: user.username,
    content: body.message ?? "[image]",
  });

  // Find all agent participants for fan-out
  const participants = await getParticipants(conversationId);
  const agentParticipants = participants.filter((p) => p.userType === "agent");
  const participantNames = participants.map((p) => p.username);

  // Resolve ports for each agent participant
  const agentTargets: { name: string; port: number }[] = [];
  const manager = getAgentManager();
  for (const ap of agentParticipants) {
    const agentEntry = findAgent(ap.username);
    if (agentEntry && manager.isRunning(ap.username)) {
      agentTargets.push({ name: ap.username, port: agentEntry.port });
    }
  }

  // If no running agents found, return error
  if (agentTargets.length === 0) {
    return c.json({ error: "No running agents in this conversation" }, 409);
  }

  // Send to all agents
  const isDM = participants.length === 2;
  const messagePayload = JSON.stringify({
    content: contentBlocks,
    channel,
    sender: user.username,
    participants: participantNames,
    participantCount: participants.length,
    isDM,
  });

  const responses: { name: string; res: Response }[] = [];
  for (const target of agentTargets) {
    try {
      const res = await fetch(`http://127.0.0.1:${target.port}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: messagePayload,
      });
      if (res.ok && res.body) {
        responses.push({ name: target.name, res });
      }
    } catch (err) {
      console.error(`[chat] agent ${target.name} unreachable on port ${target.port}:`, err);
    }
  }

  if (responses.length === 0) {
    return c.json({ error: "No agents reachable" }, 502);
  }

  // Stream the first agent's response to the client; consume others in background
  const primary = responses[0];
  const secondary = responses.slice(1);

  // Fire-and-forget for secondary agents
  for (const s of secondary) {
    consumeAndPersist(s.res, conversationId!, s.name, channel).catch((err) => {
      console.error(`[chat] failed to persist response from ${s.name}:`, err);
    });
  }

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      data: JSON.stringify({ type: "meta", conversationId }),
    });

    const assistantContent: ContentBlock[] = [];

    for await (const event of readNdjson(primary.res.body!)) {
      await stream.writeSSE({ data: JSON.stringify(event) });

      if (event.type === "text") {
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
        if (assistantContent.length > 0) {
          await addMessage(conversationId!, "assistant", primary.name, assistantContent);

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
              agent: primary.name,
              channel,
              role: "assistant",
              sender: primary.name,
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
