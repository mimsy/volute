import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { MessageChannelInfo } from "../auto-reply.js";

export function createReplyInstructionsHook(messageChannels: Map<string, MessageChannelInfo>) {
  let fired = false;

  const hook: HookCallback = async () => {
    if (fired) return {};

    const entry = messageChannels.values().next().value;
    if (!entry?.channel) return {};

    fired = true;

    const context = entry.autoReply
      ? `Auto-reply is enabled for this session — your text output will automatically be sent back to ${entry.channel}. To send to a different channel: volute send <channel> "message"`
      : `To reply to this message, use: volute send ${entry.channel} "your message"`;

    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit" as const,
        additionalContext: context,
      },
    };
  };

  return { hook };
}
