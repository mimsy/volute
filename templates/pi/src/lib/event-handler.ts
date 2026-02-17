import { commitFileChange } from "./auto-commit.js";
import type { AutoReplyTracker, MessageChannelInfo } from "./auto-reply.js";
import { log, logText, logThinking, logToolResult, logToolUse } from "./logger.js";
import type { VoluteEvent } from "./types.js";

export type EventSession = {
  name: string;
  messageIds: (string | undefined)[];
  currentMessageId?: string;
  messageChannels: Map<string, MessageChannelInfo>;
  autoReply: AutoReplyTracker;
};

export type EventHandlerOptions = {
  cwd: string;
  broadcast: (event: VoluteEvent) => void;
};

export function createEventHandler(session: EventSession, options: EventHandlerOptions) {
  const toolArgs = new Map<string, any>();
  let textBuf = "";
  let thinkingBuf = "";

  function flushText() {
    if (textBuf) {
      logText(textBuf);
      textBuf = "";
    }
  }

  function flushThinking() {
    if (thinkingBuf) {
      logThinking(thinkingBuf);
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
        session.autoReply.reset();
      }

      if (event.type === "message_update") {
        const ae = event.assistantMessageEvent;
        if (ae.type === "text_delta") {
          if (thinkingBuf) flushThinking();
          textBuf += ae.delta;
          session.autoReply.accumulate(ae.delta);
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
        session.autoReply.flush(session.currentMessageId);
        toolArgs.set(event.toolCallId, event.args);
        logToolUse(event.toolName, event.args);
      }

      if (event.type === "tool_execution_end") {
        const output =
          typeof event.result === "string" ? event.result : JSON.stringify(event.result);
        logToolResult(event.toolName, output, event.isError);

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
        session.autoReply.flush(session.currentMessageId);
        if (session.currentMessageId) {
          session.messageChannels.delete(session.currentMessageId);
        }
        log("agent", `session "${session.name}": turn done`);
        options.broadcast({ type: "done" });
        session.currentMessageId = undefined;
      }
    } catch (err) {
      log("agent", `session "${session.name}": event handler error (${event?.type}):`, err);
    }
  };
}
