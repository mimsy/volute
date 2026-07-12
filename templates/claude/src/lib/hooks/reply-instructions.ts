import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { loadPrompts } from "../startup.js";

export function createReplyInstructionsHook(
  messageChannels: Map<string, { channel: string; sender?: string }>,
  sessionState: {
    replyInstructionsFired: boolean;
    replyInstructionsMode: "once" | "always" | "never";
    currentIsEvent?: boolean;
  },
) {
  const prompts = loadPrompts();

  const hook: HookCallback = async () => {
    // System-event turns: ambient, from the environment, not a person.
    if (sessionState.currentIsEvent) {
      return {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit" as const,
          additionalContext:
            "This came from your environment, not a person. No one is waiting on a reply — " +
            "if you have somewhere to send a response, use your normal channels. Your closing " +
            "thoughts on this turn are kept as a private reflection in your history.",
        },
      };
    }

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
