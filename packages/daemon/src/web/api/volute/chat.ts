import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { getOrCreateMindUser, getOrCreateSystemUser } from "../../../lib/auth.js";
import { routeOutboundBridge } from "../../../lib/bridge-outbound.js";
import { extractTextContent } from "../../../lib/delivery/delivery-router.js";
import { deliverMessage, recordOutbound } from "../../../lib/delivery/message-delivery.js";
import { subscribe } from "../../../lib/events/conversation-events.js";
import {
  addMessage,
  type ContentBlock,
  createConversation,
  findDMConversation,
  getChannelName,
  getChannelSettings,
  getConversation,
  getParticipants,
  isParticipantOrOwner,
} from "../../../lib/events/conversations.js";
import { formatFileSize, stageFile, validateFilePath } from "../../../lib/file-sharing.js";
import log from "../../../lib/logger.js";
import { findMind, getBaseName } from "../../../lib/registry.js";
import { buildVoluteSlug } from "../../../lib/slugify.js";
import { generateSystemReply } from "../../../lib/system-chat.js";
import { getTypingMap } from "../../../lib/typing.js";
import type { AuthEnv } from "../../middleware/auth.js";

type SlugOpts = Parameters<typeof buildVoluteSlug>[0];

async function fanOutToMinds(opts: {
  conversationId: string;
  contentBlocks: ContentBlock[];
  senderName: string;
  /** Override isDM (defaults to participants.length === 2) */
  isDM?: boolean;
  /** Extra fields passed to buildVoluteSlug (e.g. convType, convName) */
  slugExtra?: Partial<SlugOpts>;
  /** Maps mind username to delivery target name (for variant-aware targeting) */
  targetName?: (username: string) => string;
}): Promise<void> {
  const participants = await getParticipants(opts.conversationId);
  const mindParticipants = participants.filter(
    (p) => p.userType === "mind" || p.userType === "system",
  );
  const participantNames = participants.map((p) => p.username);
  const isDM = opts.isDM ?? participants.length === 2;

  const { getMindManager } = await import("../../../lib/daemon/mind-manager.js");
  const { getSleepManagerIfReady } = await import("../../../lib/daemon/sleep-manager.js");
  const manager = getMindManager();
  const sm = getSleepManagerIfReady();

  // Include running minds AND sleeping minds (sleeping ones get routed through sleep queue)
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
      conversationId: opts.conversationId,
      ...opts.slugExtra,
    });
  }

  // Fire-and-forget: deliver to all target minds (running or sleeping)
  for (const mindName of targetMinds) {
    const target = opts.targetName ? opts.targetName(mindName) : mindName;
    const channel = slugForMind(mindName);
    const typingMap = getTypingMap();
    // Filter typing to only participants of this conversation (slugs are shared across DMs)
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
      log.warn(`fan-out delivery failed for ${target}`, log.errorData(err));
    });
  }
}

const fileSchema = z.object({
  filename: z.string(),
  data: z.string(), // base64
});

const chatSchema = z.object({
  message: z.string().optional(),
  conversationId: z.string().optional(),
  targetMind: z.string().optional(),
  sender: z.string().optional(),
  images: z
    .array(
      z.object({
        media_type: z.string(),
        data: z.string(),
      }),
    )
    .optional(),
  files: z.array(fileSchema).optional(),
});

const MAX_FILE_SIZE = 50 * 1024 * 1024;

function stageFilesForMinds(
  files: z.infer<typeof fileSchema>[],
  targetMinds: string[],
  senderName: string,
): { notifications: string[]; error?: { message: string; status: 400 | 413 } } {
  const notifications: string[] = [];
  for (const file of files) {
    const pathErr = validateFilePath(file.filename);
    if (pathErr)
      return { notifications, error: { message: `Invalid filename: ${pathErr}`, status: 400 } };
    const content = Buffer.from(file.data, "base64");
    if (content.length > MAX_FILE_SIZE) {
      return {
        notifications,
        error: {
          message: `File too large: ${file.filename} (${formatFileSize(content.length)}, max ${formatFileSize(MAX_FILE_SIZE)})`,
          status: 413,
        },
      };
    }
    for (const mind of targetMinds) {
      const { id } = stageFile(mind, senderName, file.filename, content, file.filename);
      notifications.push(
        `[file] ${senderName} sent ${file.filename} (${formatFileSize(content.length)}) — run: volute chat accept ${id}`,
      );
    }
  }
  return { notifications };
}

export const unifiedChatApp = new Hono<AuthEnv>().post(
  "/chat",
  zValidator("json", chatSchema),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");

    // Validate content
    if (
      !body.message &&
      (!body.images || body.images.length === 0) &&
      (!body.files || body.files.length === 0)
    ) {
      return c.json({ error: "message, images, or files required" }, 400);
    }

    // Must have conversationId or targetMind
    if (!body.conversationId && !body.targetMind) {
      return c.json({ error: "conversationId or targetMind required" }, 400);
    }

    // Resolve sender: daemon token + body.sender → override, else user.username
    const senderName = user.id === 0 && body.sender ? body.sender : user.username;

    // Detect if sender is a mind
    const senderIsMind =
      (user.id === 0 && body.sender && (await findMind(body.sender))) || user.user_type === "mind";

    // Track baseName and variant-aware targetName callback for the targetMind flow
    let baseName: string | undefined;
    let variantName: string | undefined;

    let conversationId = body.conversationId;

    if (body.targetMind) {
      // --- targetMind flow (was mind-scoped endpoint) ---
      variantName = body.targetMind;
      baseName = await getBaseName(body.targetMind);

      const entry = await findMind(baseName);
      if (!entry) return c.json({ error: "Mind not found" }, 404);

      if (conversationId) {
        // Daemon token (id: 0) can access any conversation
        if (user.id !== 0 && !(await isParticipantOrOwner(conversationId, user.id))) {
          return c.json({ error: "Conversation not found" }, 404);
        }
      } else {
        // Auto-create/reuse DM conversation
        const mindUser = await getOrCreateMindUser(baseName);
        const participantIds: number[] = [];
        if (user.id !== 0) {
          participantIds.push(user.id);
        } else if (body.sender) {
          if (body.sender === "volute") {
            const systemUser = await getOrCreateSystemUser();
            participantIds.push(systemUser.id);
          } else {
            const senderMind = await findMind(body.sender);
            if (senderMind) {
              const senderMindUser = await getOrCreateMindUser(body.sender);
              participantIds.push(senderMindUser.id);
            }
          }
        }
        participantIds.push(mindUser.id);

        // DM reuse: if exactly 2 participants, look for an existing conversation
        if (participantIds.length === 2) {
          const existing = await findDMConversation(participantIds as [number, number]);
          if (existing) {
            conversationId = existing;
          }
        }

        if (!conversationId) {
          const conv = await createConversation(baseName, "volute", {
            userId: user.id !== 0 ? user.id : undefined,
            participantIds,
          });
          conversationId = conv.id;
        }
      }
    } else {
      // --- conversationId-only flow (was unified endpoint) ---
      if (user.id !== 0 && !(await isParticipantOrOwner(conversationId!, user.id))) {
        return c.json({ error: "Conversation not found" }, 404);
      }
    }

    const conv = await getConversation(conversationId!);
    if (!conv) return c.json({ error: "Conversation not found" }, 404);
    const convName = conv.type === "channel" ? await getChannelName(conversationId!) : null;

    // Stage files
    const fileNotifications: string[] = [];
    if (body.files && body.files.length > 0) {
      let fileTargets: string[];
      if (baseName) {
        fileTargets = [baseName];
      } else {
        const participants = await getParticipants(conversationId!);
        fileTargets = participants
          .filter((p) => p.userType === "mind" && p.username !== senderName)
          .map((p) => p.username);
      }
      const { notifications, error } = stageFilesForMinds(body.files, fileTargets, senderName);
      if (error) return c.json({ error: error.message }, error.status);
      fileNotifications.push(...notifications);
    }

    // Build content blocks
    const contentBlocks: ContentBlock[] = [];
    if (body.message) contentBlocks.push({ type: "text", text: body.message });
    for (const note of fileNotifications) {
      contentBlocks.push({ type: "text", text: note });
    }
    if (body.images) {
      for (const img of body.images) {
        contentBlocks.push({ type: "image", media_type: img.media_type, data: img.data });
      }
    }

    // Enforce char_limit for mind senders in channels
    if (senderIsMind && conv.type === "channel" && convName) {
      try {
        const chSettings = await getChannelSettings(convName);
        if (chSettings?.char_limit) {
          for (const block of contentBlocks) {
            if (block.type === "text" && block.text.length > chSettings.char_limit) {
              return c.json(
                {
                  error: `Message exceeds channel character limit (${chSettings.char_limit}). Shorten your message and try again.`,
                },
                400,
              );
            }
          }
        }
      } catch (err) {
        log.warn("failed to look up channel char_limit, skipping enforcement", log.errorData(err));
      }
    }

    // Save message (turn_id and source_event_id are set to null for mind senders —
    // they'll be linked when the tool_result event arrives with the outbound correlation ID)
    const message = await addMessage(conversationId!, "user", senderName, contentBlocks);

    let outboundId: number | undefined;
    if (senderIsMind) {
      routeOutboundBridge(conversationId!, senderName, contentBlocks).catch((err) => {
        log.warn("outbound bridge routing failed", log.errorData(err));
      });
      // Record outbound event in mind_history (without turn_id — linked later via tool_result)
      const channel = buildVoluteSlug({
        participants: await getParticipants(conversationId!),
        mindUsername: senderName,
        conversationId: conversationId!,
        convType: conv.type as "dm" | "channel",
        convName,
      });
      try {
        outboundId = await recordOutbound(senderName, channel, extractTextContent(contentBlocks), {
          messageId: message?.id != null ? String(message.id) : undefined,
        });
      } catch (err) {
        log.warn(`recordOutbound failed for ${senderName}`, log.errorData(err));
      }
    }

    // Fan out to running mind participants
    const isDM = conv.type === "dm";
    await fanOutToMinds({
      conversationId: conversationId!,
      contentBlocks,
      senderName,
      isDM,
      slugExtra: { convType: conv.type as "dm" | "channel", convName },
      // Variant-aware targeting: when targetMind is a variant, route to the variant name
      targetName: baseName
        ? (username) => (username === baseName ? variantName! : username)
        : undefined,
    });

    // Check if a mind is messaging a system DM — generate AI reply
    const systemReplyTarget = baseName ?? senderName;
    if (senderIsMind && body.message) {
      const participants = await getParticipants(conversationId!);
      const hasSystemUser = participants.some((p) => p.userType === "system");
      if (hasSystemUser) {
        generateSystemReply(conversationId!, systemReplyTarget, body.message).catch((err) =>
          log.error(`system reply generation failed for ${systemReplyTarget}`, log.errorData(err)),
        );
      }
    }

    return c.json({ ok: true, conversationId, outboundId });
  },
);

// Default export: SSE endpoint only (keeps existing mount points at /api/minds and /api/v1/minds)
const app = new Hono<AuthEnv>().get("/:name/conversations/:id/events", async (c) => {
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
