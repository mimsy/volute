import { zValidator } from "@hono/zod-validator";
import { isLocalMind, isMind, isSystemSpirit } from "@volute/api/user-type";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { getOrCreateMindUser, getOrCreateSystemUser } from "../../lib/auth.js";
import { routeOutboundBridge } from "../../lib/bridges/bridge-outbound.js";
import { checkChannelLimits } from "../../lib/chat/channel-limits.js";
import { formatFileSize, stageFile, validateFilePath } from "../../lib/chat/file-sharing.js";
import {
  ensureSpiritAvailable,
  SPIRIT_NOTICE_PREFIX,
  type SpiritStatus,
} from "../../lib/chat/spirit-availability.js";
import { getActiveTurnId } from "../../lib/daemon/turn-tracker.js";
import { extractTextContent } from "../../lib/delivery/delivery-router.js";
import { fanOutToMinds } from "../../lib/delivery/fan-out.js";
import { recordOutbound } from "../../lib/delivery/message-delivery.js";
import { checkStaleSend, formatHoldNotice } from "../../lib/delivery/send-gate.js";
import { subscribe } from "../../lib/events/conversation-events.js";
import {
  addMessage,
  type ContentBlock,
  createConversation,
  findDMConversation,
  getChannelName,
  getConversation,
  getLastMessageBySender,
  getParticipants,
  isParticipantOrOwner,
} from "../../lib/events/conversations.js";
import { publish as publishMindEvent } from "../../lib/events/mind-events.js";
import { findMind, getBaseName, isSpiritName, resolveMindDir } from "../../lib/mind/registry.js";
import { readVoluteConfig } from "../../lib/mind/volute-config.js";
import { fixModelEscapes } from "../../lib/util/fix-model-escapes.js";
import log from "../../lib/util/logger.js";
import { buildVoluteSlug } from "../../lib/util/slugify.js";
import type { AuthEnv } from "../middleware/auth.js";

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

/** Conversations with a spirit-unavailable notice write in flight (double-notice guard). */
const spiritNoticeInFlight = new Set<string>();

/**
 * Persist the honest spirit-unavailable notice as a message from the spirit — once. Deduped
 * against the spirit's most recent message in the conversation (by the stable notice prefix,
 * so rewording doesn't orphan old notices): after the spirit posts anything real, the notice
 * may appear again if it becomes unavailable later, but it never stacks per send. The
 * in-flight set closes the concurrent read-then-write race.
 */
async function persistSpiritNotice(
  conversationId: string,
  spiritUsername: string,
  notice: string,
): Promise<void> {
  if (spiritNoticeInFlight.has(conversationId)) return;
  spiritNoticeInFlight.add(conversationId);
  try {
    const last = await getLastMessageBySender(conversationId, spiritUsername);
    const alreadyNoticed = last?.content.some(
      (b) => b.type === "text" && b.text.startsWith(SPIRIT_NOTICE_PREFIX),
    );
    if (!alreadyNoticed) {
      await addMessage(conversationId, "assistant", spiritUsername, [
        { type: "text", text: notice },
      ]);
    }
  } finally {
    spiritNoticeInFlight.delete(conversationId);
  }
}

/**
 * The refusal handed to a caller who asked to send as someone else. It has to settle
 * two things the old silent fallback left ambiguous: that nothing was sent, and that
 * the parameter is not a general impersonation feature. The only remedy it suggests —
 * dropping the flag — actually works from the shell the caller is already in.
 */
export function refusedSenderMessage(requested: string, actual: string): string {
  return (
    `Refused to send as "${requested}": you are authenticated as "${actual}", and a message ` +
    `is always recorded as whoever actually sent it. The "sender" field (--sender on the ` +
    `CLI) is reserved for the daemon's own internal use. Nothing was sent — re-send without ` +
    `it to post as "${actual}".`
  );
}

// Mounted at /api/v1/chat, so the route path is bare "/". See app.ts.
export const chatApp = new Hono<AuthEnv>().post("/", zValidator("json", chatSchema), async (c) => {
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

  // A caller may only speak as itself. `sender` is an override for the daemon's own
  // token, and its live use is a mind's own send relayed through the volute platform
  // driver (`VOLUTE_SENDER`), which carries a mind name. It is NOT a way to record
  // external, caller-chosen text as a sender: platform traffic gets a namespaced
  // `platform:handle` at its own inbound route (#1016), because this column also holds
  // authenticated Volute usernames and nothing else marks the difference. Anyone else asking
  // to speak as someone else is refused outright: silently recording the message under
  // the caller's own name is a confident success that answers a different question than
  // the one asked, and the sender never learns their words went out as theirs (#500).
  // Passing your own name is not impersonation — a mind's CLI sends its own name on
  // every message — so an exact match passes.
  if (body.sender && user.id !== 0 && body.sender !== user.username) {
    return c.json({ error: refusedSenderMessage(body.sender, user.username) }, 403);
  }

  // Resolve sender: daemon token + body.sender → override, else user.username
  const senderName = user.id === 0 && body.sender ? body.sender : user.username;
  // The authenticated principal behind this send (#1017). Only a real users-row
  // principal counts: the daemon token (id 0) asserting a sender name did not
  // authenticate that principal on this request, so it confers no id. The refusal
  // guard above guarantees that when user.id !== 0, senderName IS user.username.
  const senderId = user.id !== 0 ? user.id : null;

  // Detect if sender is a mind. The spirit authenticates with its
  // mind token but resolves to the shared system user (user_type "spirit"), so
  // classify a system principal whose username is a registered mind as a mind
  // sender too — this matches only the spirit, never a plain system principal.
  const senderIsMind =
    (user.id === 0 && body.sender && (await findMind(body.sender))) ||
    isMind(user) ||
    (isSystemSpirit(user) && !!(await findMind(user.username)));

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

  // Normalize the sender's own text first: fixModelEscapes changes its length, and the
  // channel's character limit has to measure the text that will actually be stored.
  let messageText = body.message ?? "";
  if (senderIsMind && messageText) {
    const vCfg = readVoluteConfig(await resolveMindDir(baseName ?? senderName));
    messageText = fixModelEscapes(messageText, vCfg?.unescapeNewlines === true);
  }

  // Enforce the channel's character and rate limits before anything is written or staged.
  // Ordering matters: staging persists a pending file offer per recipient, so checking
  // after it would leave minds holding offers for a message that was never sent — and
  // every retry would stage another copy.
  if (conv.type === "channel" && convName) {
    const rejection = await checkChannelLimits({
      conversationId: conversationId!,
      channelName: convName,
      text: messageText,
    });
    if (rejection) return c.json({ error: rejection.error }, rejection.status);
  }

  // Stage files
  const fileNotifications: string[] = [];
  if (body.files && body.files.length > 0) {
    let fileTargets: string[];
    if (baseName) {
      fileTargets = [baseName];
    } else {
      fileTargets = participants
        .filter((p) => isMind(p) && p.username !== senderName)
        .map((p) => p.username);
    }
    const { notifications, error } = stageFilesForMinds(body.files, fileTargets, senderName);
    if (error) return c.json({ error: error.message }, error.status);
    fileNotifications.push(...notifications);
  }

  // Build content blocks. The file-share notifications are system-generated text appended
  // alongside the sender's message — deliberately not part of what the character limit
  // measured above, since the sender didn't write them.
  const contentBlocks: ContentBlock[] = [];
  if (messageText) contentBlocks.push({ type: "text", text: messageText });
  for (const note of fileNotifications) {
    contentBlocks.push({ type: "text", text: note });
  }
  if (body.images) {
    for (const img of body.images) {
      contentBlocks.push({ type: "image", media_type: img.media_type, data: img.data });
    }
  }

  // Resolve the sending mind's active turn from the per-request X-Volute-Thread header
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

  // On-demand spirit start + availability surfacing (#434). ADVISORY: this must never
  // block or break message delivery — any error degrades to "no status, no notice" and
  // fan-out proceeds. Only a DM whose sole mind-ish recipient is the spirit awaits the
  // start: fan-out only delivers to running/sleeping minds, so for the DM case the await
  // IS the delivery guarantee. Channels/groups never block on a spirit start — there,
  // fan-out's skip path starts a stopped spirit fire-and-forget and this message is
  // missed, same as for any stopped mind. A sleeping spirit is left alone: its queue
  // covers the message (don't force-wake, per #418).
  let spiritStatus: SpiritStatus | undefined;
  let spiritName: string | undefined;
  try {
    const mindishRecipients = participants.filter(
      (p) => isLocalMind(p) && p.username !== senderName,
    );
    const spiritRecipient =
      conv.type === "dm" && mindishRecipients.length === 1 && isSystemSpirit(mindishRecipients[0])
        ? mindishRecipients[0]
        : undefined;
    if (spiritRecipient) {
      const availability = await ensureSpiritAvailable();
      if (availability) {
        spiritStatus = availability.status;
        spiritName = spiritRecipient.username;
        if (availability.status === "unavailable" && availability.notice) {
          await persistSpiritNotice(conversationId!, spiritRecipient.username, availability.notice);
        }
      }
    }
  } catch (err) {
    log.error("spirit availability check failed — proceeding with delivery", log.errorData(err));
  }

  // Fan out to running mind participants
  const isDM = conv.type === "dm";
  const { gatedRecipients } = await fanOutToMinds({
    conversationId: conversationId!,
    contentBlocks,
    senderName,
    senderId,
    participants,
    isDM,
    slugExtra: { convType: conv.type as "dm" | "channel", convName },
    // Variant-aware targeting: when targetMind is a variant, route to the variant name
    targetName: baseName
      ? (username) => (username === baseName ? variantName! : username)
      : undefined,
  });

  // The message is saved, but a recipient whose routing gates this channel won't see it
  // until they accept the channel — say so in the 200 instead of a bare "sent" (#723).
  const notice =
    gatedRecipients.length > 0
      ? `Note: your message is held for ${gatedRecipients.join(", ")} pending channel ` +
        `approval — they haven't routed this channel yet. It will be delivered if they ` +
        `accept the channel.`
      : undefined;

  return c.json({
    ok: true,
    conversationId,
    outboundId,
    spirit: spiritStatus,
    spiritName,
    ...(notice ? { notice } : {}),
  });
});

// Default export: SSE endpoint only, mounted on /api/v1/minds.
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
