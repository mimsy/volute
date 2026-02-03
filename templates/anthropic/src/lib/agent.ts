import {
  query,
  type SDKUserMessage,
  type McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import type { MoltMessage, MoltBlock } from "./types.js";
import { log } from "./logger.js";

type Listener = (msg: MoltMessage) => void;

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
  mcpServers?: Record<string, McpServerConfig>;
}) {
  const channel = createMessageChannel();
  const listeners = new Set<Listener>();

  const stream = query({
    prompt: channel.iterable,
    options: {
      systemPrompt: options.systemPrompt,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      cwd: options.cwd,
      abortController: options.abortController,
      mcpServers: options.mcpServers,
    },
  });

  function broadcast(msg: MoltMessage) {
    for (const listener of listeners) {
      try {
        listener(msg);
      } catch (err) {
        log("agent", "listener threw during broadcast:", err);
      }
    }
  }

  // Consume the SDK stream and broadcast MoltMessage events
  (async () => {
    log("agent", "stream consumer started");
    try {
      for await (const msg of stream) {
        if (msg.type === "assistant") {
          const blocks: MoltBlock[] = [];

          for (const b of msg.message.content) {
            if (b.type === "thinking" && "thinking" in b && b.thinking) {
              blocks.push({ type: "thinking", text: b.thinking as string });
            } else if (b.type === "text") {
              blocks.push({ type: "text", text: (b as { text: string }).text });
            } else if (b.type === "tool_use") {
              const tb = b as { id: string; name: string; input: unknown };
              blocks.push({ type: "tool_use", id: tb.id, name: tb.name, input: tb.input });
            }
          }

          if (blocks.length > 0) {
            log(
              "agent",
              "assistant msg:",
              blocks.map((b) => b.type).join(","),
            );
            broadcast({
              role: "assistant",
              blocks,
              timestamp: Date.now(),
            });
          }
        }
        if (msg.type === "result") {
          log("agent", "turn done");
          broadcast({
            role: "assistant",
            blocks: [],
            done: true,
            timestamp: Date.now(),
          });
        }
      }
    } catch (err) {
      log("agent", "stream consumer error:", err);
    }
    log("agent", "stream consumer ended");
  })();

  function sendMessage(text: string, source?: string) {
    log("agent", "sendMessage:", text.slice(0, 120), source ? `source=${source}` : "");
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

  function onMessage(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { sendMessage, onMessage };
}
