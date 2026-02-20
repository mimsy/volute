import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

export function createReplyInstructionsExtension(
  messageChannels: Map<string, string>,
): ExtensionFactory {
  return (pi) => {
    let fired = false;
    pi.on("before_agent_start", () => {
      if (fired) return {};

      const channel = messageChannels.values().next().value;
      if (!channel) return {};

      fired = true;

      return {
        message: {
          customType: "reply-instructions",
          content: `To reply to this message, use: volute send ${channel} "your message"`,
          display: true,
        },
      };
    });
  };
}
