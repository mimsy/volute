import type { query } from "@anthropic-ai/claude-agent-sdk";
import { daemonEmit, type EventType } from "./daemon-client.js";
import { log, logText, logThinking, logToolUse } from "./logger.js";
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
      const usage = msg.message.usage as {
        input_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
      const contextTokens =
        (usage?.input_tokens ?? 0) +
        (usage?.cache_creation_input_tokens ?? 0) +
        (usage?.cache_read_input_tokens ?? 0);
      if (contextTokens) callbacks.onContextTokens?.(contextTokens);
      for (const b of msg.message.content) {
        if (b.type === "thinking" && "thinking" in b && b.thinking) {
          const text = b.thinking as string;
          logThinking(text);
          emit(session, { type: "thinking", content: text });
        } else if (b.type === "text") {
          const text = (b as { text: string }).text;
          logText(text);
          emit(session, { type: "text", content: text });
        } else if (b.type === "tool_use") {
          const tb = b as { name: string; input: unknown };
          logToolUse(tb.name, tb.input);
          emit(session, {
            type: "tool_use",
            content: JSON.stringify(tb.input),
            metadata: { name: tb.name },
          });
        }
      }
    }
    if (msg.type === "result") {
      if (session.currentMessageId) {
        session.messageChannels.delete(session.currentMessageId);
      }
      log("mind", `session "${session.name}": turn done`);
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
