import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { firstReplyableEntry, isEventTurn } from "../event-turn.js";
import { loadPrompts } from "../startup.js";

export function createReplyInstructionsHook(
  messageChannels: Map<string, { channel: string; sender?: string }>,
  sessionState: {
    replyInstructionsFired: boolean;
    replyInstructionsMode: "once" | "always" | "never";
    eventNoteFired: boolean;
  },
) {
  const prompts = loadPrompts();

  const hook: HookCallback = async () => {
    // Event-ness is derived from the pending messages themselves, never from a
    // session-level "the current turn is an event" flag: `/message` returns before the turn
    // runs, so two messages can queue before the SDK fires this hook for the first, and a
    // last-write-wins flag would then describe the wrong message. `messageChannels` is
    // keyed by messageId and pruned per turn, so it always reflects what's actually pending.
    const entries = [...messageChannels.values()];

    // System-event turn: ambient, from the environment, not a person, with no channel to
    // reply to. Never emit reply instructions. The note states a standing fact about events
    // (also documented in VOLUTE.md), so it fires once per session, not on every event.
    if (isEventTurn(entries)) {
      if (sessionState.eventNoteFired) return {};
      sessionState.eventNoteFired = true;
      return {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit" as const,
          additionalContext: prompts.event_instructions,
        },
      };
    }

    // "never" suppresses reply instructions entirely
    if (sessionState.replyInstructionsMode === "never") return {};

    // "once" only fires on first message per session
    if (sessionState.replyInstructionsMode === "once" && sessionState.replyInstructionsFired)
      return {};

    // Reply instructions must name a channel the mind can actually send to — never an
    // event channel (see event-turn.ts).
    const entry = firstReplyableEntry(entries);
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
