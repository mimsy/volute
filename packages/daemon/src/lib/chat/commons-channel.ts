import { isMind } from "@volute/api/user-type";
import { getOrCreateMindUser, getOrCreateSystemUser, getUserByUsername } from "../auth.js";
import { getSpiritName } from "../config/setup.js";
import { deliverMessage } from "../delivery/message-delivery.js";
import { publish as publishActivity } from "../events/activity-events.js";
import {
  addMessage,
  createChannel,
  getDefaultChannelRow,
  getParticipants,
  joinChannel,
  markChannelDefault,
  updateChannelSettings,
} from "../events/conversations.js";
import { readRegistry } from "../mind/registry.js";
import log from "../util/logger.js";
import { deliverEvent } from "./system-events.js";

// The name a *fresh* install's commons channel is created with (#819). Existing
// installs keep whatever their default channel is already named — a house may have
// earned a proper name — because the commons is resolved by the `is_default` marker,
// not by this string. See getDefaultChannelRow / markChannelDefault.
const COMMONS_CHANNEL_NAME = "commons";
const COMMONS_CHANNEL_DESCRIPTION =
  "The commons — a shared room for every mind and the spirit on this system. " +
  "Think out loud, check in, riff, coordinate.";

let cachedChannelId: string | null = null;

/** Reset the cached channel ID (for testing). */
export function resetCommonsChannelCache(): void {
  cachedChannelId = null;
}

/**
 * Ensure the commons (default) channel exists (idempotent). Returns the
 * conversation ID. The commons is resolved by the `is_default` marker, so this
 * finds an existing default under *any* name (a renamed house channel included)
 * and only creates a fresh `#commons` when no channel is marked default yet.
 */
export async function ensureCommonsChannel(): Promise<string> {
  if (cachedChannelId) return cachedChannelId;

  const existing = await getDefaultChannelRow();
  if (existing) {
    cachedChannelId = existing.conversation_id;
    // Channels created before the default description existed have none; fill it
    // in (only when unset, so a host-edited description is never clobbered).
    if (existing.description == null) {
      await updateChannelSettings(existing.name, {
        description: COMMONS_CHANNEL_DESCRIPTION,
      });
    }
    return existing.conversation_id;
  }

  const conv = await createChannel(COMMONS_CHANNEL_NAME, undefined, {
    description: COMMONS_CHANNEL_DESCRIPTION,
  });
  await markChannelDefault(conv.id);
  cachedChannelId = conv.id;
  log.info(`created #${COMMONS_CHANNEL_NAME} channel`);
  return conv.id;
}

/** Join a user to the commons channel. */
export async function joinCommonsChannel(userId: number): Promise<void> {
  const channelId = await ensureCommonsChannel();
  await joinChannel(channelId, userId);
}

/** Join a mind to the commons channel by mind name. */
export async function joinCommonsChannelForMind(mindName: string): Promise<void> {
  const user = await getOrCreateMindUser(mindName);
  await joinCommonsChannel(user.id);
}

/** Join the spirit (the shared system user) to the commons channel. */
export async function joinCommonsChannelForSpirit(): Promise<void> {
  const user = await getOrCreateSystemUser();
  await joinCommonsChannel(user.id);
}

/**
 * Join all registered non-seed minds (and spirits) to the commons channel.
 * Idempotent; run at daemon startup so existing installs get members without
 * waiting for each mind's next restart. Seeds stay out until they sprout.
 */
export async function backfillCommonsChannelMembers(): Promise<void> {
  const entries = await readRegistry();
  for (const entry of entries) {
    if (entry.stage === "seed") continue;
    try {
      if (entry.mindType === "spirit") {
        await joinCommonsChannelForSpirit();
      } else {
        await joinCommonsChannelForMind(entry.name);
      }
    } catch (err) {
      log.error(`failed to backfill ${entry.name} into the commons`, log.errorData(err));
    }
  }
}

/**
 * Post an automated announcement to the commons channel ("X has joined", "📝 X published a
 * note …"). These are sender-less, never the spirit's voice: since the spirit shares the
 * system user (#663), attributing automation to that user made it indistinguishable from the
 * spirit's hand-written messages (#687).
 *
 * The channel row is stored with `role: "event"` and no sender so web chat and `chat read`
 * render it as an event. It is delivered to mind participants through the normal channel-message
 * path (so it follows each mind's commons routing, batching, gating, and file destinations
 * exactly like any channel message) — but with a null sender, so the prefix the mind receives
 * frames it by channel and never names the spirit or invents a sender. The spirit's own
 * hand-written messages are unaffected.
 */
export async function announceToCommons(text: string): Promise<void> {
  await ensureCommonsChannel();
  const row = await getDefaultChannelRow();
  if (!row) return; // unreachable after ensureCommonsChannel, but keeps this total

  const channelId = row.conversation_id;
  await addMessage(channelId, "event", null, [{ type: "text", text }]);

  // Deliver to all mind participants of the commons, sender-less, on the ordinary channel path.
  const participants = await getParticipants(channelId);
  // Note: this excludes the spirit (user_type "spirit"). Preserved as-is; whether
  // commons announcements should also reach the spirit is a behavior question for
  // review, not this refactor (#817).
  const mindParticipants = participants.filter(isMind);
  // The routing slug follows the channel's actual name (`#commons` on new installs,
  // an earned name like `#system` on migrated houses), not a hardcoded string.
  const channel = `#${row.name}`;
  for (const mind of mindParticipants) {
    deliverMessage(mind.username, {
      content: [{ type: "text", text }],
      channel,
      conversationId: channelId,
      sender: null,
      participants: participants.map((p) => p.username),
      participantCount: participants.length,
      isDM: false,
    }).catch((err) => {
      log.warn(`failed to deliver commons announcement to ${mind.username}`, log.errorData(err));
    });
  }
}

/**
 * Make a mind's sprout a visible event (#665). Sprouting is the most significant
 * moment in a mind's early life but used to flip the stage silently. This does two
 * things, each fail-soft so neither can block the sprout that triggered it:
 *   1. Prompts the spirit to welcome the mind in the commons — via the same
 *      daemon→spirit message path the nurture schedule uses — so the welcome is
 *      hand-written in the spirit's own voice rather than a canned template. If
 *      the spirit is unavailable there's simply no announcement (no canned
 *      fallback); the feed card below still fires.
 *   2. Publishes a persisted `mind_sprouted` activity event, which drives the home-
 *      feed "sprouted" card and prompts the dashboard to refresh the mind's stage so
 *      its seed badge flips immediately.
 */
export async function announceSprout(mindName: string): Promise<void> {
  const displayName =
    (await getUserByUsername(mindName).catch(() => null))?.display_name ?? mindName;
  const row = await getDefaultChannelRow();
  const commons = `#${row?.name ?? COMMONS_CHANNEL_NAME}`;
  // deliverEvent never throws — with the spirit unavailable the prompt stays pending
  // and reaches it on its next start or wake.
  await deliverEvent(getSpiritName(), {
    type: "lifecycle",
    meta: { subtype: "sprout-welcome", mind: mindName },
    body: `${displayName} (@${mindName}) has just sprouted into a full mind and joined ${commons}. Welcome them there in your own words.`,
  });
  await publishActivity({
    type: "mind_sprouted",
    mind: mindName,
    summary: `${displayName} sprouted`,
  }).catch((err) =>
    log.warn(`failed to publish sprout activity for ${mindName}`, log.errorData(err)),
  );
}
