import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { EventSession } from "./event-handler.js";
import { log } from "./logger.js";
import { loadPrompts } from "./startup.js";

export function createReplyInstructionsExtension(
  messageChannels: Map<string, string>,
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

        const channel = messageChannels.values().next().value;
        if (!channel) return {};

        fired = true;

        const content = prompts.reply_instructions.replace(/\$\{channel\}/g, channel);
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
