import { resolve } from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

const IDENTITY_FILES = ["SOUL.md", "MEMORY.md", "VOLUTE.md"];

export function createIdentityReloadHook(cwd: string) {
  let reloadNeeded = false;
  let reloadRequested = false;

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

  // Returns true at most once per process. A reload requests a daemon restart,
  // which normally kills this process — but if that restart fails (e.g. the
  // request errors), the process survives with reloadNeeded still set. Latching
  // on reloadRequested stops us from re-firing the restart on every later turn.
  function shouldRequestReload(): boolean {
    if (reloadNeeded && !reloadRequested) {
      reloadRequested = true;
      return true;
    }
    return false;
  }

  return { hook, shouldRequestReload };
}
