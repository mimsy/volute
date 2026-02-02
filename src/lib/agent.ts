import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

type MessageChannel = {
  push: (msg: SDKUserMessage) => void;
  iterable: AsyncIterable<SDKUserMessage>;
};

function createMessageChannel(): MessageChannel {
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

export function createAgent(options: {
  systemPrompt: string;
  cwd: string;
  abortController: AbortController;
}) {
  const channel = createMessageChannel();

  const stream = query({
    prompt: channel.iterable,
    options: {
      systemPrompt: options.systemPrompt,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      cwd: options.cwd,
      abortController: options.abortController,
    },
  });

  function sendMessage(text: string) {
    channel.push({
      type: "user",
      session_id: "",
      message: {
        role: "user",
        content: [{ type: "text", text }],
      },
      parent_tool_use_id: null,
    });
  }

  return { stream, sendMessage };
}
