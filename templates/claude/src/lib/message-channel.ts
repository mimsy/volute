import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/** A queued/in-flight message paired with the sequence number that identifies it. */
export type ChannelEntry = { msg: SDKUserMessage; seq: number };

// Module-scoped, not per-channel: rotation and the idle reaper both replace a
// session's channel with a fresh instance while carrying seqs forward (relocking
// old entries to new ones — see relockstepMessageIds in recover.ts). A per-instance
// counter would restart at 0 on every fresh channel, so a seq minted by one channel
// generation could collide with one minted by another; a single global counter makes
// every seq unique for the process's lifetime, so a stale seq can never be mistaken
// for a different message.
let nextSeq = 0;

export type MessageChannel = {
  /** Returns the sequence number minted for this message — the identity `ack()` needs. */
  push: (msg: SDKUserMessage) => number;
  /**
   * Acknowledge that the message with this `seq` has completed its turn. Identity-based
   * (not positional): the SDK folds messages that arrive mid-run into the active run, so
   * a turn's `result` can cover more than just the oldest in-flight message — see the
   * caller in stream-consumer.ts.
   */
  ack: (seq: number) => void;
  /**
   * Return every message that has not been fully processed — those delivered to
   * the consumer but not yet acked (their turn never finished) followed by those
   * still queued — paired with their `seq`, and reset the channel. Used to re-feed
   * the stream after a compaction abort so in-flight input is never lost.
   */
  recover: () => ChannelEntry[];
  /**
   * Terminate the input iterable: resolve any pending `next()` with `done: true`
   * and make subsequent `next()` calls return done. The SDK sees end-of-input and
   * shuts the query down. Used by the idle reaper to release the SDK subprocess.
   */
  close: () => void;
  /** True when nothing is queued or in flight (no pending work). */
  isEmpty: () => boolean;
  iterable: AsyncIterable<SDKUserMessage>;
};

export function createMessageChannel(): MessageChannel {
  const queue: ChannelEntry[] = [];
  // Messages handed to the consumer (the SDK's read-ahead) whose turn has not yet
  // completed. The SDK's streamInput loop pulls messages eagerly and writes them
  // to the CLI subprocess, so once delivered they no longer live in `queue`. We
  // retain them here so a compaction abort — which kills that subprocess — can
  // re-feed the unprocessed ones instead of dropping them.
  const inFlight: ChannelEntry[] = [];
  let resolve: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
  let closed = false;

  function deliver(entry: ChannelEntry): IteratorResult<SDKUserMessage> {
    inFlight.push(entry);
    return { value: entry.msg, done: false };
  }

  return {
    push(msg: SDKUserMessage) {
      const entry: ChannelEntry = { msg, seq: nextSeq++ };
      if (resolve) {
        const r = resolve;
        resolve = null;
        r(deliver(entry));
      } else {
        queue.push(entry);
      }
      return entry.seq;
    },
    ack(seq: number) {
      let i = inFlight.findIndex((e) => e.seq === seq);
      if (i !== -1) {
        inFlight.splice(i, 1);
        return;
      }
      // Defensive: shouldn't normally be in the queue when acked, but remove it
      // there too rather than leave a stranded entry if it somehow is.
      i = queue.findIndex((e) => e.seq === seq);
      if (i !== -1) queue.splice(i, 1);
    },
    recover() {
      // Resolve any pending iterator wait with done:true so it doesn't
      // leak as an orphaned promise (the old iterator is discarded after recover)
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: undefined as any, done: true });
      }
      return [...inFlight.splice(0), ...queue.splice(0)];
    },
    close() {
      closed = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: undefined as any, done: true });
      }
    },
    isEmpty() {
      return queue.length === 0 && inFlight.length === 0;
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<SDKUserMessage>> {
            if (closed) {
              return Promise.resolve({ value: undefined as any, done: true });
            }
            if (queue.length > 0) {
              return Promise.resolve(deliver(queue.shift()!));
            }
            return new Promise((r) => {
              resolve = r;
            });
          },
        };
      },
    },
  };
}
