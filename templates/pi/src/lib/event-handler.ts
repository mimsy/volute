import { commitFileChange } from "./auto-commit.js";
import { daemonEmit } from "./daemon-client.js";
import { log, logText, logThinking, logToolResult, logToolUse } from "./logger.js";
import { filterEvent, loadTransparencyPreset } from "./transparency.js";
import type { VoluteEvent } from "./types.js";

export type EventSession = {
  name: string;
  messageIds: (string | undefined)[];
  currentMessageId?: string;
  messageChannels: Map<string, string>;
};

export type EventHandlerOptions = {
  cwd: string;
  broadcast: (event: VoluteEvent) => void;
};

const preset = loadTransparencyPreset();

function emit(
  session: EventSession,
  event: { type: string; content?: string; metadata?: Record<string, unknown> },
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

export function createEventHandler(session: EventSession, options: EventHandlerOptions) {
  const toolArgs = new Map<string, any>();
  let textBuf = "";
  let thinkingBuf = "";

  function flushText() {
    if (textBuf) {
      logText(textBuf);
      emit(session, { type: "text", content: textBuf });
      textBuf = "";
    }
  }

  function flushThinking() {
    if (thinkingBuf) {
      logThinking(thinkingBuf);
      emit(session, { type: "thinking", content: thinkingBuf });
      thinkingBuf = "";
    }
  }

  function flushBuffers() {
    flushThinking();
    flushText();
  }

  return (event: any) => {
    try {
      if (session.currentMessageId === undefined) {
        flushBuffers(); // flush any leftover from a turn that ended without agent_end
        session.currentMessageId = session.messageIds.shift();
      }

      if (event.type === "message_update") {
        const ae = event.assistantMessageEvent;
        if (ae.type === "text_delta") {
          if (thinkingBuf) flushThinking();
          textBuf += ae.delta;
          // Log complete lines as they arrive
          for (let nl = textBuf.indexOf("\n"); nl !== -1; nl = textBuf.indexOf("\n")) {
            logText(textBuf.slice(0, nl + 1));
            textBuf = textBuf.slice(nl + 1);
          }
        } else if (ae.type === "thinking_delta") {
          if (textBuf) flushText();
          thinkingBuf += ae.delta;
          for (let nl = thinkingBuf.indexOf("\n"); nl !== -1; nl = thinkingBuf.indexOf("\n")) {
            logThinking(thinkingBuf.slice(0, nl + 1));
            thinkingBuf = thinkingBuf.slice(nl + 1);
          }
        }
      }

      if (event.type === "tool_execution_start") {
        flushBuffers();
        toolArgs.set(event.toolCallId, event.args);
        logToolUse(event.toolName, event.args);
        emit(session, {
          type: "tool_use",
          content: JSON.stringify(event.args),
          metadata: { name: event.toolName },
        });
      }

      if (event.type === "tool_execution_end") {
        const output =
          typeof event.result === "string" ? event.result : JSON.stringify(event.result);
        logToolResult(event.toolName, output, event.isError);
        emit(session, {
          type: "tool_result",
          content: output,
          metadata: { name: event.toolName, is_error: event.isError },
        });

        // Auto-commit file changes in home/
        if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
          const args = toolArgs.get(event.toolCallId);
          const filePath = (args as { path?: string })?.path;
          if (filePath) {
            commitFileChange(filePath, options.cwd);
          }
        }
        toolArgs.delete(event.toolCallId);
      }

      if (event.type === "agent_end") {
        flushBuffers();
        if (session.currentMessageId) {
          session.messageChannels.delete(session.currentMessageId);
        }
        log("mind", `session "${session.name}": turn done`);
        options.broadcast({ type: "done" });
        emit(session, { type: "done" });
        session.currentMessageId = undefined;
      }
    } catch (err) {
      log("mind", `session "${session.name}": event handler error (${event?.type}):`, err);
    }
  };
}
