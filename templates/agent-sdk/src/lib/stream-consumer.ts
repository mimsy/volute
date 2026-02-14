import type { query } from "@anthropic-ai/claude-agent-sdk";
import type { AutoReplyTracker, MessageChannelInfo } from "./auto-reply.js";
import { log, logText, logThinking, logToolUse } from "./logger.js";
import type { VoluteEvent } from "./types.js";

export type StreamSession = {
  name: string;
  messageIds: (string | undefined)[];
  currentMessageId?: string;
  messageChannels: Map<string, MessageChannelInfo>;
  autoReply: AutoReplyTracker;
};

export type StreamCallbacks = {
  onSessionId?: (sessionId: string) => void;
  broadcast: (event: VoluteEvent) => void;
  onTurnEnd?: () => void;
};

export async function consumeStream(
  stream: ReturnType<typeof query>,
  session: StreamSession,
  callbacks: StreamCallbacks,
) {
  for await (const msg of stream) {
    if (session.currentMessageId === undefined) {
      session.currentMessageId = session.messageIds.shift();
      session.autoReply.reset();
    }
    if ("session_id" in msg && msg.session_id) {
      callbacks.onSessionId?.(msg.session_id as string);
    }
    if (msg.type === "assistant") {
      for (const b of msg.message.content) {
        if (b.type === "thinking" && "thinking" in b && b.thinking) {
          logThinking(b.thinking as string);
        } else if (b.type === "text") {
          logText((b as { text: string }).text);
          session.autoReply.accumulate((b as { text: string }).text);
        } else if (b.type === "tool_use") {
          session.autoReply.flush(session.currentMessageId);
          const tb = b as { name: string; input: unknown };
          logToolUse(tb.name, tb.input);
        }
      }
    }
    if (msg.type === "result") {
      session.autoReply.flush(session.currentMessageId);
      if (session.currentMessageId) {
        session.messageChannels.delete(session.currentMessageId);
      }
      log("agent", `session "${session.name}": turn done`);
      const result = msg as { usage?: { input_tokens?: number; output_tokens?: number } };
      if (result.usage) {
        callbacks.broadcast({
          type: "usage",
          input_tokens: result.usage.input_tokens ?? 0,
          output_tokens: result.usage.output_tokens ?? 0,
        });
      }
      callbacks.broadcast({ type: "done" });
      session.currentMessageId = undefined;
      callbacks.onTurnEnd?.();
    }
  }
}
