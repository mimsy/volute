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

  return (event: any) => {
    try {
      if (session.currentMessageId === undefined) {
        session.currentMessageId = session.messageIds.shift();
        session.autoReply.reset();
      }

      if (event.type === "message_update") {
        const ae = event.assistantMessageEvent;
        if (ae.type === "text_delta") {
          logText(ae.delta);
          session.autoReply.accumulate(ae.delta);
        } else if (ae.type === "thinking_delta") {
          logThinking(ae.delta);
        }
      }

      if (event.type === "tool_execution_start") {
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
        session.autoReply.flush(session.currentMessageId);
        if (session.currentMessageId) {
          session.messageChannels.delete(session.currentMessageId);
        }
        log("agent", `session "${session.name}": turn done`);
        options.broadcast({ type: "done" });
        session.currentMessageId = undefined;
      }
    } catch (err) {
      log("agent", `session "${session.name}": event handler error:`, err);
    }
  };
}
