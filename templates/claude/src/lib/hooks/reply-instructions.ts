import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { loadPrompts } from "../startup.js";

export function createReplyInstructionsHook(messageChannels: Map<string, string>) {
  let fired = false;
  const prompts = loadPrompts();

  const hook: HookCallback = async () => {
    if (fired) return {};

    const channel = messageChannels.values().next().value;
    if (!channel) return {};

    fired = true;

    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit" as const,
        additionalContext: prompts.reply_instructions.replace("${channel}", channel),
      },
    };
  };

  return { hook };
}
