import type { query } from "@anthropic-ai/claude-agent-sdk";
import { daemonEmit, type EventType } from "./daemon-client.js";
import { log, warn } from "./logger.js";
import { filterEvent, loadTransparencyPreset } from "./transparency.js";
import type { VoluteEvent } from "./types.js";

export type StreamSession = {
  name: string;
  messageIds: (string | undefined)[];
  currentMessageId?: string;
  messageChannels: Map<string, string>;
};

export type StreamCallbacks = {
  onSessionId?: (sessionId: string) => void;
  broadcast: (event: VoluteEvent) => void;
  onTurnEnd?: () => void;
  onContextTokens?: (tokens: number) => void;
};

// Loaded once at startup — mind restarts on config changes
const preset = loadTransparencyPreset();

function emit(
  session: StreamSession,
  event: { type: EventType; content?: string; metadata?: Record<string, unknown> },
) {
  const channel = session.currentMessageId
    ? session.messageChannels.get(session.currentMessageId)
    : undefined;
  const filtered = filterEvent(preset, {
    ...event,
    session: session.name,
    channel,
    messageId: session.currentMessageId,
  });
  if (filtered) daemonEmit(filtered);
}

export async function consumeStream(
  stream: ReturnType<typeof query>,
  session: StreamSession,
  callbacks: StreamCallbacks,
) {
  emit(session, { type: "session_start" });
  for await (const msg of stream) {
    if (session.currentMessageId === undefined) {
      session.currentMessageId = session.messageIds.shift();
    }
    if ("session_id" in msg && msg.session_id) {
      callbacks.onSessionId?.(msg.session_id as string);
    }
    if (msg.type === "assistant") {
      const usage = msg.message.usage as unknown as Record<string, unknown> | undefined;
      const inputTokens = (usage?.input_tokens as number) ?? 0;
      const cacheCreation = (usage?.cache_creation_input_tokens as number) ?? 0;
      const cacheRead = (usage?.cache_read_input_tokens as number) ?? 0;
      const contextTokens = inputTokens + cacheCreation + cacheRead;
      if (contextTokens) callbacks.onContextTokens?.(contextTokens);
      for (const b of msg.message.content) {
        if (b.type === "thinking" && "thinking" in b && b.thinking) {
          const text = b.thinking as string;
          emit(session, { type: "thinking", content: text });
        } else if (b.type === "text") {
          const text = (b as { text: string }).text;
          emit(session, { type: "text", content: text });
        } else if (b.type === "tool_use") {
          const tb = b as { name: string; input: unknown };
          emit(session, {
            type: "tool_use",
            content: JSON.stringify(tb.input),
            metadata: { name: tb.name },
          });
        }
      }
    }
    if (msg.type === "user") {
      // Tool result messages — the SDK sends these after tool execution.
      // Extract tool_result content blocks and emit them so the daemon can
      // link outbound records to the correct turn via correlation markers.
      const content = (msg as { message?: { content?: unknown[] } }).message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (
            b &&
            typeof b === "object" &&
            "type" in b &&
            b.type === "tool_result" &&
            "content" in b
          ) {
            const resultContent = Array.isArray(b.content)
              ? b.content
                  .filter(
                    (c: unknown): c is { type: "text"; text: string } =>
                      !!c && typeof c === "object" && "type" in c && c.type === "text",
                  )
                  .map((c) => c.text)
                  .join("")
              : typeof b.content === "string"
                ? b.content
                : "";
            if (resultContent) {
              const toolName =
                "tool_use_id" in b && typeof b.tool_use_id === "string" ? b.tool_use_id : "unknown";
              emit(session, {
                type: "tool_result",
                content: resultContent,
                metadata: { tool_use_id: toolName },
              });
            }
          }
        }
      }
    }
    if (msg.type === "result") {
      if (session.currentMessageId) {
        session.messageChannels.delete(session.currentMessageId);
      }
      log("mind", `session "${session.name}": turn done`);
      // Log any error messages from the result
      const resultMsg = msg as Record<string, unknown>;
      if (Array.isArray(resultMsg.messages)) {
        for (const m of resultMsg.messages) {
          if (m && typeof m === "object" && "errorMessage" in m && m.errorMessage) {
            warn("mind", `session "${session.name}": agent error: ${m.errorMessage}`);
          }
        }
      }
      const result = msg as { usage?: { input_tokens?: number; output_tokens?: number } };
      if (result.usage) {
        const usage = {
          input_tokens: result.usage.input_tokens ?? 0,
          output_tokens: result.usage.output_tokens ?? 0,
        };
        callbacks.broadcast({ type: "usage", ...usage });
        emit(session, { type: "usage", metadata: usage });
      }
      callbacks.broadcast({ type: "done" });
      emit(session, { type: "done" });
      session.currentMessageId = undefined;
      callbacks.onTurnEnd?.();
    }
  }
}
