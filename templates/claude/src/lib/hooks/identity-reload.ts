import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { createIdentityWatch } from "../identity-watch.js";

/**
 * PreToolUse hook (Edit|Write) that feeds the shared identity watch. The file list and
 * the once-per-process latch live in `lib/identity-watch.ts` so every template's reload
 * agrees on what counts as an identity file; this is just the SDK-shaped adapter.
 */
export function createIdentityReloadHook(cwd: string) {
  const watch = createIdentityWatch(cwd);

  const hook: HookCallback = async (input) => {
    const filePath = (input as { tool_input?: { file_path?: string } }).tool_input?.file_path;
    if (filePath) watch.noteFileChange(filePath);
    return {};
  };

  return { hook, shouldRequestReload: watch.shouldRequestReload };
}
