import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { commitFileChange, waitForCommits } from "../auto-commit.js";

export function createAutoCommitHook(cwd: string) {
  const hook: HookCallback = async (input) => {
    const filePath = (input as { tool_input?: { file_path?: string } }).tool_input?.file_path;
    if (filePath) {
      commitFileChange(filePath, cwd);
    }
    return {};
  };

  return { hook, waitForCommits };
}
