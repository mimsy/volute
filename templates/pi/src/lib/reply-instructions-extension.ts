import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { loadPrompts } from "./startup.js";

export function createReplyInstructionsExtension(
  messageChannels: Map<string, string>,
): ExtensionFactory {
  const prompts = loadPrompts();
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
          content: prompts.reply_instructions.replace("${channel}", channel),
          display: true,
        },
      };
    });
  };
}
