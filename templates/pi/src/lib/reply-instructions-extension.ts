import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { EventSession } from "./event-handler.js";
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
    pi.on("before_agent_start", () => {
      try {
        if (fired) return {};

        const entry = messageChannels.values().next().value;
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
