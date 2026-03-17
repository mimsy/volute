import { resolve } from "node:path";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { EventSession } from "./event-handler.js";
import { log } from "./logger.js";
import { getSessionUpdates, resolvePiJsonl } from "./session-monitor.js";

export function createSessionContextExtension(
  options: {
    currentSession: string;
    mindDir: string;
  },
  emitContext?: (
    session: EventSession,
    event: { type: "context"; content: string; metadata: Record<string, unknown> },
  ) => void,
  session?: EventSession,
): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", () => {
      try {
        const sessionsDir = resolve(options.mindDir, ".mind/pi-sessions");
        const summary = getSessionUpdates({
          currentSession: options.currentSession,
          sessionsDir,
          cursorFile: resolve(options.mindDir, ".mind/session-cursors.json"),
          jsonlResolver: (name) => resolvePiJsonl(sessionsDir, name),
          format: "pi",
        });
        if (!summary) return {};
        if (emitContext && session) {
          emitContext(session, {
            type: "context",
            content: summary,
            metadata: { source: "session-context" },
          });
        }
        return {
          message: {
            customType: "session-update",
            content: summary,
            display: true,
          },
        };
      } catch (err) {
        log("mind", "session context extension failed:", err);
        return {};
      }
    });
  };
}
