import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export type MessageChannel = {
  push: (msg: SDKUserMessage) => void;
  drain: () => SDKUserMessage[];
  iterable: AsyncIterable<SDKUserMessage>;
};

export function createMessageChannel(): MessageChannel {
  const queue: SDKUserMessage[] = [];
  let resolve: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;

  return {
    push(msg: SDKUserMessage) {
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: msg, done: false });
      } else {
        queue.push(msg);
      }
    },
    drain() {
      // Clear any pending iterator wait so it doesn't consume a message after drain
      resolve = null;
      return queue.splice(0);
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<SDKUserMessage>> {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift()!, done: false });
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
