import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { getOrCreateMindUser } from "../../../lib/auth.js";
import { getActiveTurnId, getLastToolUseEventId } from "../../../lib/daemon/turn-tracker.js";
import { deliverMessage } from "../../../lib/delivery/message-delivery.js";
import { subscribe } from "../../../lib/events/conversation-events.js";
import {
  addMessage,
  type ContentBlock,
  createConversation,
  findDMConversation,
  getConversation,
  getParticipants,
  isParticipantOrOwner,
} from "../../../lib/events/conversations.js";
import log from "../../../lib/logger.js";
import { findMind, getBaseName } from "../../../lib/registry.js";
import { buildVoluteSlug } from "../../../lib/slugify.js";
import { getTypingMap } from "../../../lib/typing.js";
import { type AuthEnv, authMiddleware } from "../../middleware/auth.js";

type SlugOpts = Parameters<typeof buildVoluteSlug>[0];

async function fanOutToMinds(opts: {
  conversationId: string;
  contentBlocks: ContentBlock[];
  senderName: string;
  convTitle: string | null;
  isDM?: boolean;
  slugExtra?: Partial<SlugOpts>;
  targetName?: (username: string) => string;
}): Promise<void> {
  const participants = await getParticipants(opts.conversationId);
  const mindParticipants = participants.filter((p) => p.userType === "mind");
  const participantNames = participants.map((p) => p.username);
  const isDM = opts.isDM ?? participants.length === 2;

  const { getMindManager } = await import("../../../lib/daemon/mind-manager.js");
  const { getSleepManagerIfReady } = await import("../../../lib/daemon/sleep-manager.js");
  const manager = getMindManager();
  const sm = getSleepManagerIfReady();

  const targetMinds = mindParticipants
    .map((ap) => {
      const key = opts.targetName ? opts.targetName(ap.username) : ap.username;
      if (manager.isRunning(key) || sm?.isSleeping(ap.username)) return ap.username;
      return null;
    })
    .filter((n): n is string => n !== null && n !== opts.senderName);

  function slugForMind(mindUsername: string): string {
    return buildVoluteSlug({
      participants,
      mindUsername,
      convTitle: opts.convTitle,
      conversationId: opts.conversationId,
      ...opts.slugExtra,
    });
  }

  for (const mindName of targetMinds) {
    const target = opts.targetName ? opts.targetName(mindName) : mindName;
    const channel = slugForMind(mindName);
    const typingMap = getTypingMap();
    const currentlyTyping = typingMap
      .get(channel)
      .filter((name) => participantNames.includes(name));
    deliverMessage(target, {
      content: opts.contentBlocks,
      channel,
      conversationId: opts.conversationId,
      sender: opts.senderName,
      participants: participantNames,
      participantCount: participants.length,
      isDM,
      ...(currentlyTyping.length > 0 ? { typing: currentlyTyping } : {}),
    }).catch((err) => {
      log.warn("[v1-chat] delivery failed", log.errorData(err));
    });
  }
}

const mindChatSchema = z.object({
  message: z.string().optional(),
  conversationId: z.string().optional(),
  sender: z.string().optional(),
  images: z.array(z.object({ media_type: z.string(), data: z.string() })).optional(),
});

const unifiedChatSchema = z.object({
  message: z.string().optional(),
  conversationId: z.string(),
  images: z.array(z.object({ media_type: z.string(), data: z.string() })).optional(),
});

const app = new Hono<AuthEnv>()
  .use("*", authMiddleware)
  // Mind-scoped chat: POST /api/v1/minds/:name/chat
  .post("/minds/:name/chat", zValidator("json", mindChatSchema), async (c) => {
    const name = c.req.param("name");
    const baseName = await getBaseName(name);

    const entry = await findMind(baseName);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const body = c.req.valid("json");
    if (!body.message && (!body.images || body.images.length === 0)) {
      return c.json({ error: "message or images required" }, 400);
    }

    const user = c.get("user");
    const mindUser = await getOrCreateMindUser(baseName);
    const senderName = user.id === 0 && body.sender ? body.sender : user.username;

    let conversationId = body.conversationId;
    if (conversationId) {
      if (user.id !== 0 && !(await isParticipantOrOwner(conversationId, user.id))) {
        return c.json({ error: "Conversation not found" }, 404);
      }
    } else {
      const participantIds: number[] = [];
      if (user.id !== 0) {
        participantIds.push(user.id);
      } else if (body.sender) {
        const senderMind = await findMind(body.sender);
        if (senderMind) {
          const senderMindUser = await getOrCreateMindUser(body.sender);
          participantIds.push(senderMindUser.id);
        }
      }
      participantIds.push(mindUser.id);

      if (participantIds.length === 2) {
        const existing = await findDMConversation(baseName, participantIds as [number, number]);
        if (existing) conversationId = existing;
      }

      if (!conversationId) {
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
    const convTitle = conv?.title ?? null;

    const contentBlocks: ContentBlock[] = [];
    if (body.message) contentBlocks.push({ type: "text", text: body.message });
    if (body.images) {
      for (const img of body.images) {
        contentBlocks.push({ type: "image", media_type: img.media_type, data: img.data });
      }
    }

    // Link to turn: mind sender uses their active turn
    // Inbound user messages don't get turn_id — turns are created per-session
    const senderIsMind = user.id === 0 && body.sender && (await findMind(body.sender));
    const v1MindSession = c.get("mindSession");
    let v1SourceEventId: number | undefined;
    let v1TurnId: string | undefined;
    if (senderIsMind) {
      v1SourceEventId = getLastToolUseEventId(body.sender!, v1MindSession);
      v1TurnId = getActiveTurnId(body.sender!, v1MindSession);
    }

    await addMessage(conversationId, "user", senderName, contentBlocks, {
      sourceEventId: v1SourceEventId,
      turnId: v1TurnId,
    });

    const isDM = conv?.type === "dm";
    await fanOutToMinds({
      conversationId: conversationId!,
      contentBlocks,
      senderName,
      convTitle,
      isDM,
      slugExtra: conv
        ? { convType: conv.type as "dm" | "channel", convName: conv.name }
        : undefined,
      targetName: (username) => (username === baseName ? name : username),
    });

    return c.json({ ok: true, conversationId });
  })
  // Conversation SSE: GET /api/v1/minds/:name/conversations/:id/events
  .get("/minds/:name/conversations/:id/events", async (c) => {
    const conversationId = c.req.param("id");
    const user = c.get("user");
    if (user.id !== 0 && !(await isParticipantOrOwner(conversationId, user.id))) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    return streamSSE(c, async (stream) => {
      const unsubscribe = subscribe(conversationId, (event) => {
        stream.writeSSE({ data: JSON.stringify(event) }).catch((err) => {
          if (!stream.aborted) log.error("[v1-chat] SSE write error:", log.errorData(err));
        });
      });

      const keepAlive = setInterval(() => {
        stream.writeSSE({ data: "" }).catch((err) => {
          if (!stream.aborted) log.error("[v1-chat] SSE ping error:", log.errorData(err));
        });
      }, 15000);

      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          unsubscribe();
          clearInterval(keepAlive);
          resolve();
        });
      });
    });
  })
  // Unified chat: POST /api/v1/chat
  .post("/chat", zValidator("json", unifiedChatSchema), async (c) => {
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

    const contentBlocks: ContentBlock[] = [];
    if (body.message) contentBlocks.push({ type: "text", text: body.message });
    if (body.images) {
      for (const img of body.images) {
        contentBlocks.push({ type: "image", media_type: img.media_type, data: img.data });
      }
    }

    // Link to turn: mind sender uses their active turn
    const unifiedV1Session = c.get("mindSession");
    let unifiedV1SourceEventId: number | undefined;
    let unifiedV1TurnId: string | undefined;
    if (user.user_type === "mind") {
      unifiedV1SourceEventId = getLastToolUseEventId(senderName, unifiedV1Session);
      unifiedV1TurnId = getActiveTurnId(senderName, unifiedV1Session);
    }

    await addMessage(body.conversationId, "user", senderName, contentBlocks, {
      sourceEventId: unifiedV1SourceEventId,
      turnId: unifiedV1TurnId,
    });

    const isDM = conv.type === "dm";
    await fanOutToMinds({
      conversationId: body.conversationId,
      contentBlocks,
      senderName,
      convTitle: conv.title,
      isDM,
      slugExtra: { convType: conv.type as "dm" | "channel", convName: conv.name },
    });

    return c.json({ ok: true, conversationId: body.conversationId });
  });

export default app;
