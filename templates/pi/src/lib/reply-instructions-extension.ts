import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { MessageChannelInfo } from "./auto-reply.js";

export function createReplyInstructionsExtension(
  messageChannels: Map<string, MessageChannelInfo>,
): ExtensionFactory {
  return (pi) => {
    let fired = false;
    pi.on("before_agent_start", () => {
      if (fired) return {};

      const entry = messageChannels.values().next().value;
      if (!entry?.channel) return {};

      fired = true;

      const content = entry.autoReply
        ? `Auto-reply is enabled for this session — your text output will automatically be sent back to ${entry.channel}. To send to a different channel: volute send <channel> "message"`
        : `To reply to this message, use: volute send ${entry.channel} "your message"`;

      return {
        message: {
          customType: "reply-instructions",
          content,
          display: true,
        },
      };
    });
  };
}
