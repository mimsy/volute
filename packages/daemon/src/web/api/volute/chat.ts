import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { getOrCreateMindUser, getOrCreateSystemUser } from "../../../lib/auth.js";
import { routeOutboundBridge } from "../../../lib/bridges/bridge-outbound.js";
import { formatFileSize, stageFile, validateFilePath } from "../../../lib/chat/file-sharing.js";
import { ensureSpiritAvailable, type SpiritStatus } from "../../../lib/chat/spirit-availability.js";
import { getSpiritName } from "../../../lib/config/setup.js";
import { getActiveTurnId } from "../../../lib/daemon/turn-tracker.js";
import { extractTextContent } from "../../../lib/delivery/delivery-router.js";
import { fanOutToMinds } from "../../../lib/delivery/fan-out.js";
import { recordOutbound } from "../../../lib/delivery/message-delivery.js";
import { checkStaleSend, formatHoldNotice } from "../../../lib/delivery/send-gate.js";
import { subscribe } from "../../../lib/events/conversation-events.js";
import {
  addMessage,
  type ContentBlock,
  createConversation,
  findDMConversation,
  getChannelName,
  getChannelSettings,
  getConversation,
  getMessages,
  getParticipants,
  isParticipantOrOwner,
} from "../../../lib/events/conversations.js";
import { publish as publishMindEvent } from "../../../lib/events/mind-events.js";
import { findMind, getBaseName, isSpiritName, resolveMindDir } from "../../../lib/mind/registry.js";
import { readVoluteConfig } from "../../../lib/mind/volute-config.js";
import { fixModelEscapes } from "../../../lib/util/fix-model-escapes.js";
import log from "../../../lib/util/logger.js";
import { buildVoluteSlug } from "../../../lib/util/slugify.js";
import type { AuthEnv } from "../../middleware/auth.js";

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

    // Detect if sender is a mind. The spirit authenticates with its
    // mind token but resolves to the shared system user (user_type "system"), so
    // classify a system principal whose username is a registered mind as a mind
    // sender too — this matches only the spirit, never a plain system principal.
    const senderIsMind =
      (user.id === 0 && body.sender && (await findMind(body.sender))) ||
      user.user_type === "mind" ||
      (user.user_type === "system" && !!(await findMind(user.username)));

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
          if (isSpiritName(body.sender)) {
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
          const conv = await createConversation({
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
    const participants = await getParticipants(conversationId!);

    // Stage files
    const fileNotifications: string[] = [];
    if (body.files && body.files.length > 0) {
      let fileTargets: string[];
      if (baseName) {
        fileTargets = [baseName];
      } else {
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

    // Fix common model escape errors in mind-sent messages
    if (senderIsMind) {
      const vCfg = readVoluteConfig(await resolveMindDir(baseName ?? senderName));
      const shouldUnescapeNewlines = vCfg?.unescapeNewlines === true;
      for (const block of contentBlocks) {
        if (block.type === "text") {
          block.text = fixModelEscapes(block.text, shouldUnescapeNewlines);
        }
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

    // Resolve the sending mind's active turn from the per-request X-Volute-Session header
    // (captured into context as `mindSession`). This is the primary turn-attribution path:
    // it records turn_id directly on send, replacing the racy process-global VOLUTE_SESSION
    // lookup and the marker-only correlation that ran after the fact.
    let outboundTurnId: string | undefined;
    let senderBase: string | undefined;
    if (senderIsMind) {
      senderBase = await getBaseName(senderName);
      outboundTurnId = getActiveTurnId(senderBase, c.get("mindSession"));
    }

    // Stale-send hold: if a peer posted to this conversation after this mind's turn began,
    // don't post — return a plain notice (surfaced as the send command's stdout) so the mind
    // can revise or re-send. Held at most once per turn. Replaces the destructive mid-turn
    // interrupt that produced the "tool use rejected" message.
    if (senderIsMind && senderBase) {
      const gate = await checkStaleSend(senderBase, conversationId!, [senderName, senderBase]);
      if (gate.held && gate.unseen) {
        const label = buildVoluteSlug({
          participants,
          mindUsername: senderName,
          conversationId: conversationId!,
          convType: conv.type as "dm" | "channel",
          convName,
        });
        return c.json({ ok: true, held: true, notice: formatHoldNotice(label, gate.unseen) });
      }
    }

    // Save message. turn_id is attributed directly for mind senders (see above); when the
    // turn can't be resolved it stays null and is linked later via the tool_result marker.
    const message = await addMessage(conversationId!, "user", senderName, contentBlocks, {
      turnId: outboundTurnId,
    });

    let outboundId: number | undefined;
    if (senderIsMind) {
      routeOutboundBridge(conversationId!, senderName, contentBlocks).catch((err) => {
        log.warn("outbound bridge routing failed", log.errorData(err));
      });
      const channel = buildVoluteSlug({
        participants,
        mindUsername: senderName,
        conversationId: conversationId!,
        convType: conv.type as "dm" | "channel",
        convName,
      });
      const text = extractTextContent(contentBlocks);
      try {
        outboundId = await recordOutbound(senderName, channel, text, {
          messageId: message?.id != null ? String(message.id) : undefined,
          turnId: outboundTurnId,
        });
        // When the turn is known, publish the outbound to SSE now (correctly tagged).
        // Otherwise linkToolResultToTurn publishes it when the marker arrives.
        if (outboundTurnId) {
          const mindKey = senderBase ?? senderName;
          publishMindEvent(mindKey, {
            mind: mindKey,
            type: "outbound",
            channel,
            content: text,
            turnId: outboundTurnId,
          });
        }
      } catch (err) {
        log.warn(`recordOutbound failed for ${senderName}`, log.errorData(err));
      }
    }

    // On-demand spirit start (#434): if the system spirit is a recipient here and it exists
    // but is stopped, start it now so the fan-out below delivers directly. If it can't exist
    // (setup incomplete / creation failed), persist one honest notice in the conversation
    // instead of silence — no AI-generated impersonation. A sleeping spirit is left alone:
    // its queue covers the message (don't force-wake, per #418). The status is returned so
    // the web chat / CLI send ack can show "volute is waking / unavailable".
    let spiritStatus: SpiritStatus | undefined;
    const spiritParticipant = participants.find(
      (p) => p.userType === "system" && p.username !== senderName,
    );
    if (spiritParticipant) {
      const availability = await ensureSpiritAvailable();
      spiritStatus = availability.status;
      if (availability.status === "unavailable" && availability.notice) {
        // A single clear notice, not one per send: skip when it already appears
        // among the recent messages (the sender's own send is the latest, so
        // check a small window rather than just the last message).
        const notice = availability.notice;
        const recent = await getMessages(conversationId!, 10);
        const alreadyNoticed = recent.some(
          (m) =>
            m.sender_name === getSpiritName() &&
            m.content.some((b) => b.type === "text" && b.text === notice),
        );
        if (!alreadyNoticed) {
          await addMessage(conversationId!, "assistant", getSpiritName(), [
            { type: "text", text: notice },
          ]);
        }
      }
    }

    // Fan out to running mind participants
    const isDM = conv.type === "dm";
    await fanOutToMinds({
      conversationId: conversationId!,
      contentBlocks,
      senderName,
      participants,
      isDM,
      slugExtra: { convType: conv.type as "dm" | "channel", convName },
      // Variant-aware targeting: when targetMind is a variant, route to the variant name
      targetName: baseName
        ? (username) => (username === baseName ? variantName! : username)
        : undefined,
    });

    return c.json({ ok: true, conversationId, outboundId, spirit: spiritStatus });
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
