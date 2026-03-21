import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { loadPrompts } from "../startup.js";

export function createReplyInstructionsHook(
  messageChannels: Map<string, { channel: string; sender?: string }>,
) {
  let fired = false;
  const prompts = loadPrompts();

  const hook: HookCallback = async () => {
    if (fired) return {};

    const entry = messageChannels.values().next().value;
    if (!entry) return {};

    fired = true;

    // System messages don't need reply instructions
    if (entry.sender === "volute") {
      return {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit" as const,
          additionalContext: "This is a system message — no reply is needed.",
        },
      };
    }

    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit" as const,
        additionalContext: prompts.reply_instructions.replace(/\$\{channel\}/g, entry.channel),
      },
    };
  };

  return { hook };
}
