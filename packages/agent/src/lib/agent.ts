import {
  query,
  type SDKUserMessage,
  type McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import type { ChatMessage } from "./types.js";
import { log } from "./logger.js";

type Listener = (msg: ChatMessage) => void;

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

  function broadcast(msg: ChatMessage) {
    for (const listener of listeners) {
      try {
        listener(msg);
      } catch (err) {
        log("agent", "listener threw during broadcast:", err);
      }
    }
  }

  // Consume the SDK stream and broadcast ChatMessage events
  (async () => {
    log("agent", "stream consumer started");
    try {
      for await (const msg of stream) {
        if (msg.type === "assistant") {
          const textBlocks = msg.message.content.filter(
            (b: { type: string }) => b.type === "text",
          );
          const text = textBlocks
            .map((b: { text: string }) => b.text)
            .join("");

          const toolBlocks = msg.message.content.filter(
            (b: { type: string }) => b.type === "tool_use",
          );
          const toolCalls = toolBlocks.map(
            (b: { name: string; input: unknown }) => ({
              name: b.name,
              input: b.input,
            }),
          );

          if (text || toolCalls.length > 0) {
            log(
              "agent",
              "assistant msg:",
              text ? text.slice(0, 120) : "(no text)",
              toolCalls.length > 0
                ? `tools=[${toolCalls.map((t: { name: string }) => t.name).join(",")}]`
                : "",
            );
            broadcast({
              role: "assistant",
              content: text,
              toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
              timestamp: Date.now(),
            });
          }
        }
        if (msg.type === "result") {
          log("agent", "turn done");
          broadcast({
            role: "assistant",
            content: "",
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

  function sendMessage(text: string) {
    log("agent", "sendMessage:", text.slice(0, 120));
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
