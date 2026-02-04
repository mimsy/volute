import { query } from "@anthropic-ai/claude-agent-sdk";
import type { MoltEvent, MoltContentPart } from "./types.js";
import { log } from "./logger.js";
import { createMessageChannel } from "./message-channel.js";

type Listener = (event: MoltEvent) => void;

export function createAgent(options: {
  systemPrompt: string;
  cwd: string;
  abortController: AbortController;
  resume?: string;
  onSessionId?: (id: string) => void;
  onStreamError?: (err: unknown) => void;
  onCompact?: () => void;
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
      resume: options.resume,
    },
  });

  function broadcast(event: MoltEvent) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        log("agent", "listener threw during broadcast:", err);
      }
    }
  }

  // Consume the SDK stream and broadcast MoltEvent events
  (async () => {
    log("agent", "stream consumer started");
    try {
      for await (const msg of stream) {
        if ("session_id" in msg && msg.session_id && options.onSessionId) {
          options.onSessionId(msg.session_id as string);
        }
        if (msg.type === "assistant") {
          for (const b of msg.message.content) {
            if (b.type === "thinking" && "thinking" in b && b.thinking) {
              log("agent", "thinking:", (b.thinking as string).slice(0, 200));
            } else if (b.type === "text") {
              broadcast({ type: "text", content: (b as { text: string }).text });
            } else if (b.type === "tool_use") {
              const tb = b as { name: string; input: unknown };
              broadcast({ type: "tool_use", name: tb.name, input: tb.input });
            } else if (b.type === "image" && "source" in b) {
              const src = b.source as { type: string; media_type: string; data: string };
              if (src.type === "base64") {
                broadcast({ type: "image", media_type: src.media_type, data: src.data });
              }
            }
          }
        }
        if (msg.type === "result") {
          log("agent", "turn done");
          broadcast({ type: "done" });
        }
        if (
          msg.type === "system" &&
          "subtype" in msg &&
          msg.subtype === "compact_boundary"
        ) {
          log("agent", "compact boundary detected");
          if (options.onCompact) options.onCompact();
        }
      }
    } catch (err) {
      log("agent", "stream consumer error:", err);
      if (options.onStreamError) options.onStreamError(err);
      process.exit(1);
    }
    log("agent", "stream consumer ended");
  })();

  function sendMessage(content: string | MoltContentPart[], source?: string) {
    const preview = typeof content === "string"
      ? content.slice(0, 120)
      : content.map((p) => p.type).join(",");
    log("agent", "sendMessage:", preview, source ? `source=${source}` : "");

    const sdkContent = typeof content === "string"
      ? [{ type: "text" as const, text: content }]
      : content.map((part) => {
          if (part.type === "text") {
            return { type: "text" as const, text: part.text };
          }
          return {
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: part.media_type,
              data: part.data,
            },
          };
        });

    channel.push({
      type: "user",
      session_id: "",
      message: {
        role: "user",
        content: sdkContent,
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
