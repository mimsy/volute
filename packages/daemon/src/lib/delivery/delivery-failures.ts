/**
 * Sender-side delivery-failure notices, coalesced per (sender mind, channel).
 *
 * Fan-out fires deliverMessage without awaiting, so a failed delivery used to
 * collapse into a daemon-log warn — invisible to the sender who already got
 * HTTP 200 + "Message sent." (#723). When the sender is a mind, we surface the
 * failure as a next-turn notice via recordNotice.
 *
 * A downed recipient can fail many sends in a burst, so notices coalesce: the
 * first failure in a window notices immediately; further failures within
 * {@link FAILURE_NOTICE_WINDOW_MS} only accumulate, and the next failure after
 * the window emits one rollup ("N messages ... have failed since {time}").
 */
import { MIND_LEVEL_THREAD, type RecordNoticeInput } from "../chat/system-events.js";
import log from "../util/logger.js";

const dlog = log.child("delivery-failures");

/** At most one notice per (sender mind, channel) within this window. */
export const FAILURE_NOTICE_WINDOW_MS = 15 * 60 * 1000;

/** Prune buckets untouched for this long (nothing left to roll up). */
const BUCKET_IDLE_MS = 2 * FAILURE_NOTICE_WINDOW_MS;

type Bucket = {
  /** Failures accumulated since the last notice. */
  count: number;
  /** Time of the first failure in the current accumulation. */
  firstFailedAt: number;
  lastNoticeAt: number;
  lastFailureAt: number;
};

const buckets = new Map<string, Bucket>();

type Notifier = (input: RecordNoticeInput) => Promise<void>;

const defaultNotifier: Notifier = async (input) => {
  const { recordNotice } = await import("../chat/system-events.js");
  await recordNotice(input);
};

let notifier: Notifier = defaultNotifier;
let clock: () => number = () => Date.now();

/** Test seam: capture/override the recorded notices. */
export function setSendFailureNotifier(fn?: Notifier): void {
  notifier = fn ?? defaultNotifier;
}

/** Test seam: override the clock used for coalescing windows. */
export function setSendFailureClock(fn?: () => number): void {
  clock = fn ?? (() => Date.now());
}

/** Test seam: drop all coalescing state. */
export function resetSendFailureState(): void {
  buckets.clear();
}

function localHM(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Report that a message a mind sent on `channel` was not delivered to `recipient`.
 * Records a next-turn notice for the sender, coalesced per (sender, channel).
 * Never throws — this runs on the fire-and-forget fan-out path.
 */
export async function reportSendFailure(opts: {
  /** The sending mind (base name) — the one who was told "Message sent." */
  senderMind: string;
  /** The conversation slug from the sender's perspective (e.g. `@bardo`, `#general`). */
  channel: string;
  /** The recipient the delivery failed for. */
  recipient: string;
  /** Short machine-ish cause, e.g. "delivery-error" or "recipient-not-running". */
  reason: string;
}): Promise<void> {
  const now = clock();
  const key = `${opts.senderMind}\u0000${opts.channel}`;

  // Sweep idle buckets so distinct (mind, channel) pairs can't accumulate forever.
  if (buckets.size > 200) {
    for (const [k, b] of buckets) {
      if (now - b.lastFailureAt > BUCKET_IDLE_MS) buckets.delete(k);
    }
  }

  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { count: 0, firstFailedAt: now, lastNoticeAt: 0, lastFailureAt: now };
    buckets.set(key, bucket);
  }
  if (bucket.count === 0) bucket.firstFailedAt = now;
  bucket.count++;
  bucket.lastFailureAt = now;

  if (now - bucket.lastNoticeAt < FAILURE_NOTICE_WINDOW_MS) return; // coalesced

  const { count, firstFailedAt } = bucket;
  bucket.lastNoticeAt = now;
  bucket.count = 0;

  const detail =
    count === 1
      ? `Your message on ${opts.channel} could not be delivered to ${opts.recipient} ` +
        `(${opts.reason}). It is saved in the conversation history, but they have not ` +
        `received it.`
      : `${count} messages on ${opts.channel} have failed to be delivered since ` +
        `${localHM(firstFailedAt)}, most recently to ${opts.recipient} (${opts.reason}). ` +
        `They are saved in the conversation history, but were not received.`;

  try {
    await notifier({
      mind: opts.senderMind,
      thread: MIND_LEVEL_THREAD,
      kind: "delivery_failed",
      reason: "send_failed",
      detail,
    });
  } catch (err) {
    dlog.warn(`failed to record send-failure notice for ${opts.senderMind}`, log.errorData(err));
  }
}
