import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { loadPrompts } from "../startup.js";

export function createReplyInstructionsHook(
  messageChannels: Map<string, { channel: string; sender?: string }>,
  sessionState: {
    replyInstructionsFired: boolean;
    replyInstructionsMode: "once" | "always" | "never";
  },
) {
  const prompts = loadPrompts();

  const hook: HookCallback = async () => {
    // "never" suppresses reply instructions entirely
    if (sessionState.replyInstructionsMode === "never") return {};

    // "once" only fires on first message per session
    if (sessionState.replyInstructionsMode === "once" && sessionState.replyInstructionsFired)
      return {};

    const entry = messageChannels.values().next().value;
    if (!entry) return {};

    sessionState.replyInstructionsFired = true;

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
