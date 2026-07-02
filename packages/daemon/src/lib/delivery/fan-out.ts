/**
 * Shared fan-out: deliver one conversation message to every mind participant.
 *
 * This is the single fan-out path used by both the chat API (`/chat`) and the
 * bridge inbound path. It also holds mind→mind loop protection: after too many
 * consecutive automated (mind-authored) turns without human input, fan-out to
 * minds is paused and a one-time notice is posted, so two minds can't ping-pong
 * unbounded.
 */
import { getOrCreateSystemUser } from "../auth.js";
import { getTypingMap } from "../chat/typing.js";
import { getMindManager } from "../daemon/mind-manager.js";
import { getSleepManagerIfReady } from "../daemon/sleep-manager.js";
import { addMessage, type ContentBlock, getParticipants } from "../events/conversations.js";
import log from "../util/logger.js";
import { buildVoluteSlug } from "../util/slugify.js";
import { deliverMessage } from "./message-delivery.js";

type Participant = Awaited<ReturnType<typeof getParticipants>>[number];
type SlugOpts = Parameters<typeof buildVoluteSlug>[0];

export interface FanOutOpts {
  conversationId: string;
  contentBlocks: ContentBlock[];
  senderName: string;
  /** Whether the sender is itself a mind — drives loop protection (increment vs. reset). */
  senderIsMind?: boolean;
  /** Participants; fetched from the conversation if not provided. */
  participants?: Participant[];
  /** Override isDM (defaults to participants.length === 2). */
  isDM?: boolean;
  /** Extra fields passed to buildVoluteSlug (e.g. convType, convName). */
  slugExtra?: Partial<SlugOpts>;
  /** Maps a mind username to its delivery target name (variant-aware targeting). */
  targetName?: (username: string) => string;
}

/**
 * Max consecutive mind-authored turns in a conversation before fan-out to minds is
 * paused. A non-mind (human/bridge) message resets the counter.
 */
export const MAX_CONSECUTIVE_MIND_TURNS = 6;

const consecutiveMindTurns = new Map<string, number>();

/** Reset the loop-protection counter for a conversation (e.g. on human input). */
export function resetLoopCounter(conversationId: string): void {
  consecutiveMindTurns.delete(conversationId);
}

async function emitLoopNotice(conversationId: string): Promise<void> {
  const systemUser = await getOrCreateSystemUser();
  await addMessage(conversationId, "user", systemUser.username, [
    {
      type: "text",
      text: `[System] This exchange has continued for ${MAX_CONSECUTIVE_MIND_TURNS} consecutive automated turns without human input, so automatic delivery between minds has been paused. Send a message to resume.`,
    },
  ]);
}

export async function fanOutToMinds(opts: FanOutOpts): Promise<void> {
  const participants = opts.participants ?? (await getParticipants(opts.conversationId));
  const mindParticipants = participants.filter(
    (p) => p.userType === "mind" || p.userType === "system",
  );
  const participantNames = participants.map((p) => p.username);
  const isDM = opts.isDM ?? participants.length === 2;

  // --- Loop protection ---
  // Only meaningful when there's more than one mind in the conversation. fanOutToMinds
  // runs for EVERY posted message, so a mind posting into a DM/channel where it's the
  // only mind has no peer to loop with — it must not trip the counter or inject the
  // "delivery paused" notice into a conversation with zero mind→mind delivery.
  if (mindParticipants.length > 1) {
    if (opts.senderIsMind) {
      const count = (consecutiveMindTurns.get(opts.conversationId) ?? 0) + 1;
      consecutiveMindTurns.set(opts.conversationId, count);
      if (count > MAX_CONSECUTIVE_MIND_TURNS) {
        // Emit the notice once as we cross the threshold, then pause fan-out until a
        // non-mind message resets the counter.
        if (count === MAX_CONSECUTIVE_MIND_TURNS + 1) {
          await emitLoopNotice(opts.conversationId).catch((err) =>
            log.warn(`failed to emit loop notice for ${opts.conversationId}`, log.errorData(err)),
          );
        }
        log.warn(
          `loop protection: paused mind fan-out for ${opts.conversationId} after ${count} consecutive mind turns`,
        );
        return;
      }
    } else {
      // A human/bridge message breaks the chain.
      consecutiveMindTurns.delete(opts.conversationId);
    }
  }

  const manager = getMindManager();
  const sm = getSleepManagerIfReady();

  // Include running minds AND sleeping minds (sleeping ones route through the sleep queue).
  const targetMinds = mindParticipants
    .map((ap) => {
      const key = opts.targetName ? opts.targetName(ap.username) : ap.username;
      if (manager.isRunning(key) || sm?.isSleeping(ap.username)) return ap.username;
      return null;
    })
    .filter((n): n is string => n !== null && n !== opts.senderName);

  // Fire-and-forget: deliver to all target minds (running or sleeping)
  for (const mindName of targetMinds) {
    const target = opts.targetName ? opts.targetName(mindName) : mindName;
    const channel = buildVoluteSlug({
      participants,
      mindUsername: mindName,
      conversationId: opts.conversationId,
      ...opts.slugExtra,
    });
    const typingMap = getTypingMap();
    // Filter typing to only participants of this conversation (slugs are shared across DMs).
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
