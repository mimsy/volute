import { resolve } from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

const IDENTITY_FILES = ["SOUL.md", "MEMORY.md", "VOLUTE.md"];

export function createIdentityReloadHook(cwd: string) {
  let reloadNeeded = false;

  const hook: HookCallback = async (input) => {
    const filePath = (input as { tool_input?: { file_path?: string } }).tool_input?.file_path;
    if (filePath) {
      const resolved = resolve(cwd, filePath);
      const fileName = resolved.slice(resolved.lastIndexOf("/") + 1);
      if (IDENTITY_FILES.includes(fileName) && resolved.startsWith(resolve(cwd))) {
        reloadNeeded = true;
      }
    }
    return {};
  };

  function needsReload(): boolean {
    return reloadNeeded;
  }

  return { hook, needsReload };
}
