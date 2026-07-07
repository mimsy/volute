import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export type MessageChannel = {
  push: (msg: SDKUserMessage) => void;
  /** Acknowledge that the oldest in-flight message's turn has completed. */
  ack: () => void;
  /**
   * Return every message that has not been fully processed — those delivered to
   * the consumer but not yet acked (their turn never finished) followed by those
   * still queued — and reset the channel. Used to re-feed the stream after a
   * compaction abort so in-flight input is never lost.
   */
  recover: () => SDKUserMessage[];
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
  const queue: SDKUserMessage[] = [];
  // Messages handed to the consumer (the SDK's read-ahead) whose turn has not yet
  // completed. The SDK's streamInput loop pulls messages eagerly and writes them
  // to the CLI subprocess, so once delivered they no longer live in `queue`. We
  // retain them here so a compaction abort — which kills that subprocess — can
  // re-feed the unprocessed ones instead of dropping them.
  const inFlight: SDKUserMessage[] = [];
  let resolve: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
  let closed = false;

  function deliver(msg: SDKUserMessage): IteratorResult<SDKUserMessage> {
    inFlight.push(msg);
    return { value: msg, done: false };
  }

  return {
    push(msg: SDKUserMessage) {
      if (resolve) {
        const r = resolve;
        resolve = null;
        r(deliver(msg));
      } else {
        queue.push(msg);
      }
    },
    ack() {
      inFlight.shift();
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
