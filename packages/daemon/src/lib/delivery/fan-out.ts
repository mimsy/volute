/**
 * Shared fan-out: deliver one conversation message to every mind participant.
 *
 * This is the single fan-out path used by both the chat API (`/chat`) and the
 * bridge inbound path.
 */
import { getTypingMap } from "../chat/typing.js";
import { getMindManager } from "../daemon/mind-manager.js";
import { getSleepManagerIfReady } from "../daemon/sleep-manager.js";
import { type ContentBlock, getParticipants } from "../events/conversations.js";
import log from "../util/logger.js";
import { buildVoluteSlug } from "../util/slugify.js";
import { deliverMessage } from "./message-delivery.js";

type Participant = Awaited<ReturnType<typeof getParticipants>>[number];
type SlugOpts = Parameters<typeof buildVoluteSlug>[0];

export interface FanOutOpts {
  conversationId: string;
  contentBlocks: ContentBlock[];
  senderName: string;
  /** Participants; fetched from the conversation if not provided. */
  participants?: Participant[];
  /** Override isDM (defaults to participants.length === 2). */
  isDM?: boolean;
  /** Extra fields passed to buildVoluteSlug (e.g. convType, convName). */
  slugExtra?: Partial<SlugOpts>;
  /** Maps a mind username to its delivery target name (variant-aware targeting). */
  targetName?: (username: string) => string;
}

export async function fanOutToMinds(opts: FanOutOpts): Promise<void> {
  const participants = opts.participants ?? (await getParticipants(opts.conversationId));
  const mindParticipants = participants.filter(
    (p) => p.userType === "mind" || p.userType === "system",
  );
  const participantNames = participants.map((p) => p.username);
  const isDM = opts.isDM ?? participants.length === 2;

  const manager = getMindManager();
  const sm = getSleepManagerIfReady();

  // Include running minds AND sleeping minds (sleeping ones route through the sleep queue).
  const targetMinds = mindParticipants
    .map((ap) => {
      const key = opts.targetName ? opts.targetName(ap.username) : ap.username;
      if (manager.isRunning(key) || sm?.isSleeping(ap.username)) return ap.username;
      if (ap.username !== opts.senderName) {
        // This is the load-bearing silent drop in delivery: a stopped participant simply
        // never receives the message. Make it traceable (#434).
        log.warn(
          `fan-out: skipping ${ap.username} (not running) for conversation ${opts.conversationId}`,
        );
        if (ap.userType === "system") {
          // A stopped spirit reached outside POST /chat (bridge inbound, channels): start
          // it fire-and-forget so the NEXT message reaches it — this one is missed, same
          // as for any stopped mind. Advisory and never throws; there is no response
          // channel here, so no notice either.
          import("../chat/spirit-availability.js")
            .then(({ ensureSpiritAvailable }) => ensureSpiritAvailable())
            .catch((err) => log.warn("fan-out: on-demand spirit start failed", log.errorData(err)));
        }
      }
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
