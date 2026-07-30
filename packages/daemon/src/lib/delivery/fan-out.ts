/**
 * Shared fan-out: deliver one conversation message to every mind participant.
 *
 * This is the single fan-out path used by both the chat API (`/chat`) and the
 * bridge inbound path.
 */
import { isLocalMind, isMind, isSystemSpirit } from "@volute/api/user-type";
import { recordDeliveryFailure } from "../chat/delivery-notices.js";
import { getTypingMap } from "../chat/typing.js";
import { getMindManager } from "../daemon/mind-manager.js";
import { getSleepManagerIfReady } from "../daemon/sleep-manager.js";
import { type ContentBlock, getParticipants } from "../events/conversations.js";
import { getBaseName, readAllMinds } from "../mind/registry.js";
import log from "../util/logger.js";
import { buildVoluteSlug } from "../util/slugify.js";
import { deliverMessage, willGateMessage } from "./message-delivery.js";

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

export interface FanOutResult {
  /**
   * Mind participants whose routing will hold this message in the gate (unrouted
   * channel, gating on) rather than deliver it. Lets the chat API tell the sender
   * in the 200 response that the message is held pending channel approval (#723).
   */
  gatedRecipients: string[];
}

export async function fanOutToMinds(opts: FanOutOpts): Promise<FanOutResult> {
  const participants = opts.participants ?? (await getParticipants(opts.conversationId));
  const mindParticipants = participants.filter(isLocalMind);
  const participantNames = participants.map((p) => p.username);
  const isDM = opts.isDM ?? participants.length === 2;

  const manager = getMindManager();
  const sm = getSleepManagerIfReady();

  // Registry names, read once per fan-out (a scan of the small `minds` table —
  // bounded by mind count, and fan-out already queries the DB) rather than a
  // findMind per participant, which would be N queries and force this map async.
  // A mind-typed participant with no `minds` row is an external mind: it pulls its
  // messages and is never spawned, so "not running" is its expected steady state,
  // not the stopped-native-mind condition the warn below traces (#434).
  const registeredMinds = new Set((await readAllMinds()).map((m) => m.name));

  // When the sender is itself a registered mind, delivery failures are surfaced back to
  // it via the shared delivery-notices machinery (#762) — it was told "Message sent."
  // and would otherwise never learn the recipient didn't receive it (#723). Resolved
  // lazily (failures are rare) and to the BASE name: a variant sender's notice must be recorded under the
  // base mind — notices are drained by base name (see minds.ts /history/notices), so a
  // variant-keyed row would strand forever — and the slug must be built from the base
  // username (the one actually in the participants list) so the channel names the
  // recipient, not the sender's own base user.
  const senderIsMind = registeredMinds.has(opts.senderName);
  let senderCtx: Promise<{ base: string; channel: string }> | undefined;
  const reportFailure = (reason: string) => {
    if (!senderIsMind) return;
    senderCtx ??= getBaseName(opts.senderName).then((base) => ({
      base,
      channel: buildVoluteSlug({
        participants,
        mindUsername: base,
        conversationId: opts.conversationId,
        ...opts.slugExtra,
      }),
    }));
    senderCtx
      .then(({ base, channel }) => recordDeliveryFailure({ mind: base, channel, reason }))
      .catch((err) => log.warn("fan-out: failed to report send failure", log.errorData(err)));
  };

  // Include running minds AND sleeping minds (sleeping ones route through the sleep queue).
  const targetMinds = mindParticipants
    .map((ap) => {
      const key = opts.targetName ? opts.targetName(ap.username) : ap.username;
      if (manager.isRunning(key) || sm?.isSleeping(ap.username)) return ap.username;
      if (ap.username !== opts.senderName) {
        // This is the load-bearing silent drop in delivery: a stopped participant simply
        // never receives the message. Make it traceable (#434) — but only for minds that
        // have a registry row, i.e. ones that were meant to be running.
        if (registeredMinds.has(ap.username)) {
          log.warn(
            `fan-out: skipping ${ap.username} (not running) for conversation ${opts.conversationId}`,
          );
          reportFailure(`${ap.username} is not running`);
        } else if (isMind(ap)) {
          // External mind (no registry row): it pulls its messages, so this is its
          // expected steady state — but a stale registry (mind deleted, user row and
          // participation left behind) looks identical, so leave a trace (#723).
          log.info(
            `fan-out: skipping ${ap.username} (no registry row — external mind or stale ` +
              `participant) for conversation ${opts.conversationId}`,
          );
        }
        if (isSystemSpirit(ap)) {
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

  // Per-target delivery descriptors: the target process name (variant-aware) and the
  // channel slug from that recipient's perspective — shared by the gate prediction and
  // the delivery payload so the two provably see the same routing metadata.
  const targets = targetMinds.map((mindName) => ({
    mindName,
    target: opts.targetName ? opts.targetName(mindName) : mindName,
    channel: buildVoluteSlug({
      participants,
      mindUsername: mindName,
      conversationId: opts.conversationId,
      ...opts.slugExtra,
    }),
  }));

  // Predict the gate the same way deliverMessage will resolve it, so the caller can
  // tell the sender the message is held rather than delivered (#723). Advisory only —
  // a prediction failure must not block delivery. Sleeping recipients never gate on
  // this path: their message goes to the sleep queue and is delivered on wake, so a
  // "held pending approval" notice for them would be false. Checked concurrently —
  // this runs before the caller's 200 and must not serialize per-recipient lookups.
  const gatedRecipients = (
    await Promise.all(
      targets.map(async ({ mindName, target, channel }) => {
        if (sm?.isSleeping(mindName)) return null;
        try {
          const gated = await willGateMessage(target, {
            channel,
            sender: opts.senderName,
            isDM,
            participantCount: participants.length,
          });
          return gated ? mindName : null;
        } catch (err) {
          log.warn(`fan-out: will-gate check failed for ${target}`, log.errorData(err));
          return null;
        }
      }),
    )
  ).filter((n): n is string => n !== null);

  // Fire-and-forget: deliver to all target minds (running or sleeping)
  for (const { mindName, target, channel } of targets) {
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
    }).then(
      (ok) => {
        // deliverMessage returned false: it failed BEFORE a delivery_queue row existed
        // (mind not found, sleep-queue error, routing crash) — the redrive loop cannot
        // recover it, so the message is genuinely lost. Surface it to the sender (#723).
        if (!ok) {
          log.warn(`fan-out delivery failed for ${target} (message not delivered)`);
          reportFailure(`the delivery to ${mindName} failed`);
        }
      },
      (err) => {
        log.warn(`fan-out delivery failed for ${target}`, log.errorData(err));
        reportFailure(`the delivery to ${mindName} failed`);
      },
    );
  }
  return { gatedRecipients };
}
