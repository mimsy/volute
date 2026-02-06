import { execFile } from "node:child_process";
import { resolve } from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { log } from "../logger.js";

function exec(cmd: string, args: string[], cwd: string): Promise<{ code: number }> {
  return new Promise((r) => {
    execFile(cmd, args, { cwd }, (_err) => {
      r({ code: _err ? 1 : 0 });
    });
  });
}

export function createAutoCommitHook(cwd: string) {
  // Serialize git operations to prevent concurrent commits from conflicting
  let pending = Promise.resolve();

  function commitFileChange(filePath: string): void {
    const homeDir = resolve(cwd);
    const resolved = resolve(cwd, filePath);
    if (!resolved.startsWith(`${homeDir}/`) && resolved !== homeDir) return;

    const relativePath = resolved.slice(homeDir.length + 1);
    if (!relativePath) return;

    pending = pending.then(async () => {
      if ((await exec("git", ["add", relativePath], cwd)).code !== 0) {
        log("auto-commit", `git add failed for ${relativePath}`);
        return;
      }
      if ((await exec("git", ["diff", "--cached", "--quiet"], cwd)).code === 0) return;

      const message = `Update ${relativePath}`;
      if ((await exec("git", ["commit", "-m", message], cwd)).code === 0) {
        log("auto-commit", message);
      }
    });
  }

  const hook: HookCallback = async (input) => {
    const filePath = (input as { tool_input?: { file_path?: string } }).tool_input?.file_path;
    if (filePath) {
      commitFileChange(filePath);
    }
    return {};
  };

  function waitForCommits(): Promise<void> {
    return pending.then(() => {});
  }

  return { hook, waitForCommits };
}
