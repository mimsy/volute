import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { getOrCreateAgentUser } from "../../../lib/auth.js";
import {
  addMessage,
  type ContentBlock,
  createConversation,
  findDMConversation,
  getParticipants,
  isParticipantOrOwner,
} from "../../../lib/conversations.js";
import { readNdjson } from "../../../lib/ndjson.js";
import { daemonLoopback, findAgent, voluteHome } from "../../../lib/registry.js";
import type { VoluteEvent } from "../../../types.js";
import type { AuthEnv } from "../../middleware/auth.js";

const chatSchema = z.object({
  message: z.string().optional(),
  conversationId: z.string().optional(),
  sender: z.string().optional(),
  images: z
    .array(
      z.object({
        media_type: z.string(),
        data: z.string(),
      }),
    )
    .optional(),
});

function getDaemonUrl(): string {
  const data = JSON.parse(readFileSync(resolve(voluteHome(), "daemon.json"), "utf-8"));
  return `http://${daemonLoopback()}:${data.port}`;
}

function daemonFetchInternal(path: string, body: string): Promise<Response> {
  const daemonUrl = getDaemonUrl();
  const token = process.env.VOLUTE_DAEMON_TOKEN;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Origin: daemonUrl,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${daemonUrl}${path}`, { method: "POST", headers, body });
}

/** Accumulate a single ndjson event into a content block array. */
function accumulateEvent(content: ContentBlock[], event: VoluteEvent): void {
  if (event.type === "text") {
    const last = content[content.length - 1];
    if (last && last.type === "text") last.text += event.content;
    else content.push({ type: "text", text: event.content });
  } else if (event.type === "tool_use") {
    content.push({ type: "tool_use", name: event.name, input: event.input });
  } else if (event.type === "tool_result") {
    content.push({
      type: "tool_result",
      output: event.output,
      ...(event.is_error ? { is_error: true } : {}),
    });
  }
}

/** Consume an agent's ndjson response and persist to conversation messages. */
async function consumeAndPersist(
  res: Response,
  conversationId: string,
  agentName: string,
): Promise<ContentBlock[]> {
  if (!res.body) {
    console.warn(`[chat] no response body from ${agentName}`);
    return [];
  }
  const assistantContent: ContentBlock[] = [];
  for await (const event of readNdjson(res.body)) {
    accumulateEvent(assistantContent, event);
    if (event.type === "done") break;
  }
  if (assistantContent.length === 0) return [];

  try {
    await addMessage(conversationId, "assistant", agentName, assistantContent);
  } catch (err) {
    console.error(`[chat] failed to persist conversation message from ${agentName}:`, err);
  }
  return assistantContent;
}

const app = new Hono<AuthEnv>().post("/:name/chat", zValidator("json", chatSchema), async (c) => {
  const name = c.req.param("name");
  const [baseName] = name.split("@", 2);

  const entry = findAgent(baseName);
  if (!entry) return c.json({ error: "Agent not found" }, 404);

  const body = c.req.valid("json");
  if (!body.message && (!body.images || body.images.length === 0)) {
    return c.json({ error: "message or images required" }, 400);
  }

  const user = c.get("user");
  const agentUser = await getOrCreateAgentUser(baseName);

  // Daemon token callers can override the sender name
  const senderName = user.id === 0 && body.sender ? body.sender : user.username;

  // Resolve or create conversation
  let conversationId = body.conversationId;
  if (conversationId) {
    // Daemon token (id: 0) can access any conversation
    if (user.id !== 0 && !(await isParticipantOrOwner(conversationId, user.id))) {
      return c.json({ error: "Conversation not found" }, 404);
    }
  } else {
    const title = body.message ? body.message.slice(0, 80) : "Image message";
    // If sender is a registered agent, include them as a participant
    const participantIds: number[] = [];
    if (user.id !== 0) {
      participantIds.push(user.id);
    } else if (body.sender) {
      // Check if sender is an agent — if so, add their agent user as participant
      const senderAgent = findAgent(body.sender);
      if (senderAgent) {
        const senderAgentUser = await getOrCreateAgentUser(body.sender);
        participantIds.push(senderAgentUser.id);
      }
    }
    participantIds.push(agentUser.id);

    // DM reuse: if exactly 2 participants, look for an existing conversation
    if (participantIds.length === 2) {
      const existing = await findDMConversation(baseName, participantIds as [number, number]);
      if (existing) {
        conversationId = existing;
      }
    }

    if (!conversationId) {
      const conv = await createConversation(baseName, "volute", {
        userId: user.id !== 0 ? user.id : undefined,
        title,
        participantIds,
      });
      conversationId = conv.id;
    }
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
  await addMessage(conversationId, "user", senderName, contentBlocks);

  // Find all agent participants for fan-out
  const participants = await getParticipants(conversationId);
  const agentParticipants = participants.filter((p) => p.userType === "agent");
  const participantNames = participants.map((p) => p.username);

  // Find running agent participants (excluding the sender)
  const { getAgentManager } = await import("../../../lib/agent-manager.js");
  const manager = getAgentManager();
  const runningAgents = agentParticipants
    .map((ap) => {
      // Use the full name (with variant) for the addressed agent, base name for others
      const agentKey = ap.username === baseName ? name : ap.username;
      return manager.isRunning(agentKey) ? ap.username : null;
    })
    .filter((n): n is string => n !== null && n !== senderName);

  // Build payload for daemon /message route
  const isDM = participants.length === 2;
  const payload = JSON.stringify({
    content: contentBlocks,
    channel,
    sender: senderName,
    participants: participantNames,
    participantCount: participants.length,
    isDM,
  });

  // Send to all agents via daemon /message route
  const responses: { name: string; res: Response }[] = [];
  for (const agentName of runningAgents) {
    const targetName = agentName === baseName ? name : agentName;
    try {
      const res = await daemonFetchInternal(
        `/api/agents/${encodeURIComponent(targetName)}/message`,
        payload,
      );
      if (res.ok && res.body) {
        responses.push({ name: agentName, res });
      } else {
        const errorBody = await res.text().catch(() => "");
        console.error(
          `[chat] agent ${agentName} responded with ${res.status}: ${errorBody.slice(0, 500)}`,
        );
      }
    } catch (err) {
      console.error(`[chat] agent ${agentName} unreachable via daemon:`, err);
    }
  }

  // No running agents — message is persisted, return empty stream
  if (responses.length === 0) {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        data: JSON.stringify({ type: "meta", conversationId }),
      });
      await stream.writeSSE({ data: JSON.stringify({ type: "sync" }) });
    });
  }

  // Stream the first agent's response to the client; consume others concurrently
  const primary = responses[0];
  const secondary = responses.slice(1);

  // Start consuming secondary responses immediately (runs concurrently with primary streaming)
  const secondaryPromises = secondary.map((s) => consumeAndPersist(s.res, conversationId!, s.name));

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      data: JSON.stringify({ type: "meta", conversationId, senderName: primary.name }),
    });

    const assistantContent: ContentBlock[] = [];

    try {
      for await (const event of readNdjson(primary.res.body!)) {
        await stream.writeSSE({ data: JSON.stringify(event) });
        accumulateEvent(assistantContent, event);
        if (event.type === "done") break;
      }
    } catch (err) {
      console.error(`[chat] error streaming response from ${primary.name}:`, err);
      await stream.writeSSE({
        data: JSON.stringify({ type: "error", message: "Stream interrupted" }),
      });
    }

    // Persist primary response to conversation messages (daemon already handled agent_messages)
    if (assistantContent.length > 0) {
      try {
        await addMessage(conversationId!, "assistant", primary.name, assistantContent);
      } catch (err) {
        console.error(`[chat] failed to persist response from ${primary.name}:`, err);
      }
    }

    // Wait for secondary agent responses to complete
    const results = await Promise.allSettled(secondaryPromises);
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") {
        console.error(
          `[chat] secondary agent ${secondary[i].name} response failed:`,
          (results[i] as PromiseRejectedResult).reason,
        );
      }
    }

    // Signal frontend that all responses are persisted
    await stream.writeSSE({ data: JSON.stringify({ type: "sync" }) });
  });
});

export default app;
