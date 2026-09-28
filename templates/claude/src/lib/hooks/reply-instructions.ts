import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { loadPrompts } from "../startup.js";
import { type TurnContextState, type TurnEntry, turnContextFor } from "../turn-context.js";

export function createReplyInstructionsHook(
  messageChannels: Map<string, TurnEntry>,
  sessionState: TurnContextState,
) {
  const prompts = loadPrompts();

  const hook: HookCallback = async () => {
    // Event-ness and the reply mode are derived from the pending messages themselves, never
    // from a session-level "the current turn is an event" flag: `/message` returns before the
    // turn runs, so two messages can queue before the SDK fires this hook for the first, and a
    // last-write-wins flag would then describe the wrong message. `messageChannels` is
    // keyed by messageId and pruned per turn, so it always reflects what's actually pending.
    const context = turnContextFor([...messageChannels.values()], sessionState, prompts);
    if (!context) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit" as const,
        additionalContext: context.content,
      },
    };
  };

  return { hook };
}
