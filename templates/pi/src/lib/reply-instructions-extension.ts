import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { EventSession } from "./event-handler.js";
import { log } from "./logger.js";
import { loadPrompts } from "./startup.js";
import { type TurnContextState, type TurnEntry, turnContextFor } from "./turn-context.js";

export function createReplyInstructionsExtension(
  messageChannels: Map<string, TurnEntry>,
  emitContext?: (
    session: EventSession,
    event: { type: "context"; content: string; metadata: Record<string, unknown> },
  ) => void,
  session?: EventSession,
): ExtensionFactory {
  const prompts = loadPrompts();
  return (pi) => {
    const state: TurnContextState = { eventNoteFired: false, replyInstructionsFired: false };
    pi.on("before_agent_start", () => {
      try {
        // Derived from the pending messages themselves, as claude's hook does — see there.
        const context = turnContextFor([...messageChannels.values()], state, prompts);
        if (!context) return {};
        if (emitContext && session) {
          emitContext(session, {
            type: "context",
            content: context.content,
            metadata: { source: context.source },
          });
        }
        return {
          message: {
            customType: context.source,
            content: context.content,
            display: true,
          },
        };
      } catch (err) {
        log("mind", "reply instructions extension failed:", err);
        return {};
      }
    });
  };
}
