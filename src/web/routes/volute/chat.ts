import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { writeChannelEntry } from "../../../connectors/sdk.js";
import { getOrCreateAgentUser } from "../../../lib/auth.js";
import { subscribe } from "../../../lib/conversation-events.js";
import {
  addMessage,
  type ContentBlock,
  createConversation,
  findDMConversation,
  getConversation,
  getParticipants,
  isParticipantOrOwner,
} from "../../../lib/conversations.js";
import { daemonLoopback, findAgent, voluteHome } from "../../../lib/registry.js";
import { slugify } from "../../../lib/slugify.js";
import { getTypingMap } from "../../../lib/typing.js";
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
  try {
    const data = JSON.parse(readFileSync(resolve(voluteHome(), "daemon.json"), "utf-8"));
    return `http://${daemonLoopback()}:${data.port}`;
  } catch (err) {
    throw new Error(`Failed to read daemon config: ${err instanceof Error ? err.message : err}`);
  }
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

const app = new Hono<AuthEnv>()
  .post("/:name/chat", zValidator("json", chatSchema), async (c) => {
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
        // Title from participant names (e.g. "alice, mystery")
        const participantNames = new Set([senderName, baseName]);
        const title = [...participantNames].join(", ");

        const conv = await createConversation(baseName, "volute", {
          userId: user.id !== 0 ? user.id : undefined,
          title,
          participantIds,
        });
        conversationId = conv.id;
      }
    }

    // Build a human-readable channel slug for this conversation
    const conv = await getConversation(conversationId);
    const convTitle = conv?.title;
    const channel = convTitle ? `volute:${slugify(convTitle)}` : `volute:${conversationId}`;

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

    // Write slug → platformId mapping for all agent participants so they can resolve it
    const channelEntry = {
      platformId: conversationId!,
      platform: "volute",
      name: convTitle ?? undefined,
      type: (isDM ? "dm" : "group") as "dm" | "group",
    };
    for (const ap of agentParticipants) {
      try {
        writeChannelEntry(ap.username, channel, channelEntry);
      } catch (err) {
        console.warn(`[chat] failed to write channel entry for ${ap.username}:`, err);
      }
    }
    const typingMap = getTypingMap();
    const currentlyTyping = typingMap.get(channel);
    const payload = JSON.stringify({
      content: contentBlocks,
      channel,
      conversationId,
      sender: senderName,
      participants: participantNames,
      participantCount: participants.length,
      isDM,
      ...(currentlyTyping.length > 0 ? { typing: currentlyTyping } : {}),
    });

    // Fire-and-forget: send to all running agents via daemon /message route
    for (const agentName of runningAgents) {
      const targetName = agentName === baseName ? name : agentName;
      daemonFetchInternal(`/api/agents/${encodeURIComponent(targetName)}/message`, payload)
        .then(async (res) => {
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            console.error(`[chat] agent ${agentName} responded ${res.status}: ${text}`);
          }
        })
        .catch((err) => {
          console.error(`[chat] agent ${agentName} unreachable via daemon:`, err);
        });
    }

    return c.json({ ok: true, conversationId });
  })
  // SSE endpoint for conversation events (new messages + typing)
  .get("/:name/conversations/:id/events", async (c) => {
    const conversationId = c.req.param("id");
    const user = c.get("user");
    // Daemon token (id: 0) bypasses participant check
    if (user.id !== 0 && !(await isParticipantOrOwner(conversationId, user.id))) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    return streamSSE(c, async (stream) => {
      const unsubscribe = subscribe(conversationId, (event) => {
        stream.writeSSE({ data: JSON.stringify(event) }).catch((err) => {
          if (!stream.aborted) console.error("[chat] SSE write error:", err);
        });
      });

      // Keep-alive ping every 15s
      const keepAlive = setInterval(() => {
        stream.writeSSE({ data: "" }).catch((err) => {
          if (!stream.aborted) console.error("[chat] SSE ping error:", err);
        });
      }, 15000);

      // Wait until the client disconnects
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          unsubscribe();
          clearInterval(keepAlive);
          resolve();
        });
      });
    });
  });

export default app;
