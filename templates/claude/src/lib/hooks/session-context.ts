import { resolve } from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { getSessionUpdates, resolveAgentSdkJsonl } from "../session-monitor.js";

export function createSessionContextHook(options: {
  currentSession: string;
  sessionsDir: string;
  cwd: string;
}) {
  const hook: HookCallback = async () => {
    try {
      const summary = getSessionUpdates({
        currentSession: options.currentSession,
        sessionsDir: options.sessionsDir,
        cursorFile: resolve(options.sessionsDir, "../session-cursors.json"),
        jsonlResolver: (name) => resolveAgentSdkJsonl(options.sessionsDir, name, options.cwd),
        format: "agent-sdk",
      });
      if (!summary) return {};
      return {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit" as const,
          additionalContext: summary,
        },
      };
    } catch {
      return {};
    }
  };

  return { hook };
}
