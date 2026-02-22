import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { writeChannelEntry } from "../../../connectors/sdk.js";
import { getOrCreateMindUser } from "../../../lib/auth.js";
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
import { deliverMessage } from "../../../lib/message-delivery.js";
import { findMind } from "../../../lib/registry.js";
import { buildVoluteSlug } from "../../../lib/slugify.js";
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

const app = new Hono<AuthEnv>()
  .post("/:name/chat", zValidator("json", chatSchema), async (c) => {
    const name = c.req.param("name");
    const [baseName] = name.split("@", 2);

    const entry = findMind(baseName);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const body = c.req.valid("json");
    if (!body.message && (!body.images || body.images.length === 0)) {
      return c.json({ error: "message or images required" }, 400);
    }

    const user = c.get("user");
    const mindUser = await getOrCreateMindUser(baseName);

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
      // If sender is a registered mind, include them as a participant
      const participantIds: number[] = [];
      if (user.id !== 0) {
        participantIds.push(user.id);
      } else if (body.sender) {
        // Check if sender is a mind — if so, add their mind user as participant
        const senderMind = findMind(body.sender);
        if (senderMind) {
          const senderMindUser = await getOrCreateMindUser(body.sender);
          participantIds.push(senderMindUser.id);
        }
      }
      participantIds.push(mindUser.id);

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

    const conv = await getConversation(conversationId);
    const convTitle = conv?.title;

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

    // Find all mind participants for fan-out
    const participants = await getParticipants(conversationId);
    const mindParticipants = participants.filter((p) => p.userType === "mind");
    const participantNames = participants.map((p) => p.username);

    // Find running mind participants (excluding the sender)
    const { getMindManager } = await import("../../../lib/mind-manager.js");
    const manager = getMindManager();
    const runningMinds = mindParticipants
      .map((ap) => {
        // Use the full name (with variant) for the addressed mind, base name for others
        const mindKey = ap.username === baseName ? name : ap.username;
        return manager.isRunning(mindKey) ? ap.username : null;
      })
      .filter((n): n is string => n !== null && n !== senderName);

    // Build channel slug — @username for DMs (matching the volute channel driver)
    const isDM = participants.length === 2;
    function channelForMind(mindUsername: string): string {
      return buildVoluteSlug({
        participants,
        mindUsername,
        convTitle,
        conversationId: conversationId!,
      });
    }

    // Write slug → platformId mapping for all mind participants so they can resolve it
    const channelEntry = {
      platformId: conversationId!,
      platform: "volute",
      name: convTitle ?? undefined,
      type: (isDM ? "dm" : "group") as "dm" | "group",
    };
    for (const ap of mindParticipants) {
      try {
        writeChannelEntry(ap.username, channelForMind(ap.username), channelEntry);
      } catch (err) {
        console.warn(`[chat] failed to write channel entry for ${ap.username}:`, err);
      }
    }

    // Fire-and-forget: send to all running minds via direct delivery
    for (const mindName of runningMinds) {
      const targetName = mindName === baseName ? name : mindName;
      const channel = channelForMind(mindName);
      const typingMap = getTypingMap();
      const currentlyTyping = typingMap.get(channel);
      deliverMessage(targetName, {
        content: contentBlocks,
        channel,
        conversationId,
        sender: senderName,
        participants: participantNames,
        participantCount: participants.length,
        isDM,
        ...(currentlyTyping.length > 0 ? { typing: currentlyTyping } : {}),
      }).catch(() => {}); // deliverMessage logs errors internally
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

const unifiedChatSchema = z.object({
  message: z.string().optional(),
  conversationId: z.string(),
  images: z.array(z.object({ media_type: z.string(), data: z.string() })).optional(),
});

export const unifiedChatApp = new Hono<AuthEnv>().post(
  "/chat",
  zValidator("json", unifiedChatSchema),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    if (!body.message && (!body.images || body.images.length === 0)) {
      return c.json({ error: "message or images required" }, 400);
    }

    const conv = await getConversation(body.conversationId);
    if (!conv) return c.json({ error: "Conversation not found" }, 404);

    if (user.id !== 0 && !(await isParticipantOrOwner(body.conversationId, user.id))) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    const senderName = user.username;

    // Build content blocks
    const contentBlocks: ContentBlock[] = [];
    if (body.message) contentBlocks.push({ type: "text", text: body.message });
    if (body.images) {
      for (const img of body.images) {
        contentBlocks.push({ type: "image", media_type: img.media_type, data: img.data });
      }
    }

    await addMessage(body.conversationId, "user", senderName, contentBlocks);

    // Fan out to running mind participants
    const participants = await getParticipants(body.conversationId);
    const mindParticipants = participants.filter((p) => p.userType === "mind");
    const participantNames = participants.map((p) => p.username);

    const { getMindManager } = await import("../../../lib/mind-manager.js");
    const manager = getMindManager();
    const runningMinds = mindParticipants
      .map((ap) => (manager.isRunning(ap.username) ? ap.username : null))
      .filter((n): n is string => n !== null && n !== senderName);

    const isDM = conv.type === "dm" && participants.length === 2;
    const channelEntry = {
      platformId: body.conversationId,
      platform: "volute",
      name: conv.title ?? undefined,
      type: (conv.type === "channel" ? "group" : isDM ? "dm" : "group") as "dm" | "group",
    };
    for (const ap of mindParticipants) {
      const slug = buildVoluteSlug({
        participants,
        mindUsername: ap.username,
        convTitle: conv.title,
        conversationId: conv.id,
        convType: conv.type,
        convName: conv.name,
      });
      try {
        writeChannelEntry(ap.username, slug, channelEntry);
      } catch (err) {
        console.warn(`[chat] failed to write channel entry for ${ap.username}:`, err);
      }
    }

    for (const mindName of runningMinds) {
      const channel = buildVoluteSlug({
        participants,
        mindUsername: mindName,
        convTitle: conv.title,
        conversationId: body.conversationId,
        convType: conv.type,
        convName: conv.name,
      });
      const typingMap = getTypingMap();
      const currentlyTyping = typingMap.get(channel);
      deliverMessage(mindName, {
        content: contentBlocks,
        channel,
        conversationId: body.conversationId,
        sender: senderName,
        participants: participantNames,
        participantCount: participants.length,
        isDM,
        ...(currentlyTyping.length > 0 ? { typing: currentlyTyping } : {}),
      }).catch(() => {}); // deliverMessage logs errors internally
    }

    return c.json({ ok: true, conversationId: body.conversationId });
  },
);

export default app;
