import { resolve } from "node:path";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { getSessionUpdates, resolvePiJsonl } from "./session-monitor.js";

export function createSessionContextExtension(options: {
  currentSession: string;
  cwd: string;
}): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", () => {
      try {
        const sessionsDir = resolve(options.cwd, ".mind/pi-sessions");
        const summary = getSessionUpdates({
          currentSession: options.currentSession,
          sessionsDir,
          cursorFile: resolve(options.cwd, ".mind/session-cursors.json"),
          jsonlResolver: (name) => resolvePiJsonl(sessionsDir, name),
          format: "pi",
        });
        if (!summary) return {};
        return {
          message: {
            customType: "session-update",
            content: summary,
            display: true,
          },
        };
      } catch {
        return {};
      }
    });
  };
}
