import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { EventSession } from "./event-handler.js";
import { firstReplyableEntry, isEventTurn } from "./event-turn.js";
import { log } from "./logger.js";
import { loadPrompts } from "./startup.js";

export function createReplyInstructionsExtension(
  messageChannels: Map<string, { channel: string; sender?: string }>,
  emitContext?: (
    session: EventSession,
    event: { type: "context"; content: string; metadata: Record<string, unknown> },
  ) => void,
  session?: EventSession,
): ExtensionFactory {
  const prompts = loadPrompts();
  return (pi) => {
    let fired = false;
    let eventNoteFired = false;
    pi.on("before_agent_start", () => {
      try {
        const entries = [...messageChannels.values()];

        // System-event turn: ambient, from the environment, with no channel to reply to.
        // The note fires once per session (see event-turn.ts for why).
        if (isEventTurn(entries)) {
          if (eventNoteFired) return {};
          eventNoteFired = true;
          const content = prompts.event_instructions;
          if (emitContext && session) {
            emitContext(session, {
              type: "context",
              content,
              metadata: { source: "event-instructions" },
            });
          }
          return {
            message: {
              customType: "event-instructions",
              content,
              display: true,
            },
          };
        }

        if (fired) return {};

        // Reply instructions must name a channel the mind can actually send to.
        const entry = firstReplyableEntry(entries);
        if (!entry) return {};

        fired = true;

        // System messages don't need reply instructions
        if (entry.sender === "volute") {
          const content = "This is a system message — no reply is needed.";
          if (emitContext && session) {
            emitContext(session, {
              type: "context",
              content,
              metadata: { source: "reply-instructions" },
            });
          }
          return {
            message: {
              customType: "reply-instructions",
              content,
              display: true,
            },
          };
        }

        const content = prompts.reply_instructions.replace(/\$\{channel\}/g, entry.channel);
        if (emitContext && session) {
          emitContext(session, {
            type: "context",
            content,
            metadata: { source: "reply-instructions" },
          });
        }

        return {
          message: {
            customType: "reply-instructions",
            content,
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
