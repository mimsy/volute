import { getOrCreateMindUser, getOrCreateSystemUser, getUserByUsername } from "../auth.js";
import { getSpiritName } from "../config/setup.js";
import { deliverMessage } from "../delivery/message-delivery.js";
import { publish as publishActivity } from "../events/activity-events.js";
import {
  addMessage,
  createChannel,
  getChannelByName,
  getChannelSettings,
  getParticipants,
  joinChannel,
  updateChannelSettings,
} from "../events/conversations.js";
import { readRegistry } from "../mind/registry.js";
import log from "../util/logger.js";
import { deliverEvent } from "./system-events.js";

const SYSTEM_CHANNEL_NAME = "system";
const SYSTEM_CHANNEL_DESCRIPTION =
  "The commons — a shared room for every mind and the spirit on this system. " +
  "Think out loud, check in, riff, coordinate.";

let cachedChannelId: string | null = null;

/** Reset the cached channel ID (for testing). */
export function resetSystemChannelCache(): void {
  cachedChannelId = null;
}

/** Ensure the #system channel exists (idempotent). Returns the conversation ID. */
export async function ensureSystemChannel(): Promise<string> {
  if (cachedChannelId) return cachedChannelId;

  const existing = await getChannelByName(SYSTEM_CHANNEL_NAME);
  if (existing) {
    cachedChannelId = existing.id;
    // Channels created before the default description existed have none; fill it
    // in (only when unset, so a host-edited description is never clobbered).
    const settings = await getChannelSettings(SYSTEM_CHANNEL_NAME);
    if (settings && settings.description == null) {
      await updateChannelSettings(SYSTEM_CHANNEL_NAME, {
        description: SYSTEM_CHANNEL_DESCRIPTION,
      });
    }
    return existing.id;
  }

  const conv = await createChannel(SYSTEM_CHANNEL_NAME, undefined, {
    description: SYSTEM_CHANNEL_DESCRIPTION,
  });
  cachedChannelId = conv.id;
  log.info("created #system channel");
  return conv.id;
}

/** Join a brain user to the #system channel. */
export async function joinSystemChannel(userId: number): Promise<void> {
  const channelId = await ensureSystemChannel();
  await joinChannel(channelId, userId);
}

/** Join a mind to the #system channel by mind name. */
export async function joinSystemChannelForMind(mindName: string): Promise<void> {
  const user = await getOrCreateMindUser(mindName);
  await joinSystemChannel(user.id);
}

/** Join the spirit (the shared system user) to the #system channel. */
export async function joinSystemChannelForSpirit(): Promise<void> {
  const user = await getOrCreateSystemUser();
  await joinSystemChannel(user.id);
}

/**
 * Join all registered non-seed minds (and spirits) to the #system channel.
 * Idempotent; run at daemon startup so existing installs get members without
 * waiting for each mind's next restart. Seeds stay out until they sprout.
 */
export async function backfillSystemChannelMembers(): Promise<void> {
  const entries = await readRegistry();
  for (const entry of entries) {
    if (entry.stage === "seed") continue;
    try {
      if (entry.mindType === "spirit") {
        await joinSystemChannelForSpirit();
      } else {
        await joinSystemChannelForMind(entry.name);
      }
    } catch (err) {
      log.error(`failed to backfill ${entry.name} into #system`, log.errorData(err));
    }
  }
}

/** Post a system announcement to the #system channel and deliver to mind participants. */
export async function announceToSystem(text: string): Promise<void> {
  const channelId = await ensureSystemChannel();
  const systemUser = await getOrCreateSystemUser();

  // Ensure system user is a participant
  await joinChannel(channelId, systemUser.id);

  await addMessage(channelId, "user", systemUser.username, [{ type: "text", text }]);

  // Deliver to all mind participants of #system
  const participants = await getParticipants(channelId);
  const mindParticipants = participants.filter((p) => p.userType === "mind");
  const channel = "#system";
  for (const mind of mindParticipants) {
    deliverMessage(mind.username, {
      content: [{ type: "text", text }],
      channel,
      conversationId: channelId,
      sender: systemUser.username,
      participants: participants.map((p) => p.username),
      participantCount: participants.length,
      isDM: false,
    }).catch((err) => {
      log.warn(`failed to deliver system announcement to ${mind.username}`, log.errorData(err));
    });
  }
}

/**
 * Make a mind's sprout a visible event (#665). Sprouting is the most significant
 * moment in a mind's early life but used to flip the stage silently. This does two
 * things, each fail-soft so neither can block the sprout that triggered it:
 *   1. Prompts the spirit to welcome the mind in #system — via the same
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
  // deliverEvent never throws — with the spirit unavailable the prompt stays pending
  // and reaches it on its next start or wake.
  await deliverEvent(getSpiritName(), {
    type: "lifecycle",
    meta: { subtype: "sprout-welcome", mind: mindName },
    body: `${displayName} (@${mindName}) has just sprouted into a full mind and joined #system. Welcome them there in your own words.`,
  });
  await publishActivity({
    type: "mind_sprouted",
    mind: mindName,
    summary: `${displayName} sprouted`,
  }).catch((err) =>
    log.warn(`failed to publish sprout activity for ${mindName}`, log.errorData(err)),
  );
}
