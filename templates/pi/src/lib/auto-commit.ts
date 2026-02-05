import { spawn } from "child_process";
import { log } from "./logger.js";

/**
 * Commit a file change in the agent's home directory.
 * Called by the PostToolUse hook when Edit or Write completes.
 */
export function commitFileChange(filePath: string, cwd: string): void {
  // Only commit files in home/
  if (!filePath.startsWith("home/") && !filePath.includes("/home/")) {
    return;
  }

  // Extract relative path within home/
  const homeIndex = filePath.indexOf("home/");
  const relativePath = filePath.slice(homeIndex);

  // Run git add and commit
  const gitAdd = spawn("git", ["add", relativePath], { cwd });
  gitAdd.on("close", (code) => {
    if (code !== 0) {
      log("auto-commit", `git add failed for ${relativePath}`);
      return;
    }

    // Check if there are staged changes
    const gitDiff = spawn("git", ["diff", "--cached", "--quiet"], { cwd });
    gitDiff.on("close", (diffCode) => {
      if (diffCode === 0) {
        // No changes to commit
        return;
      }

      const message = `Update ${relativePath}`;
      const gitCommit = spawn("git", ["commit", "-m", message], { cwd });
      gitCommit.on("close", (commitCode) => {
        if (commitCode === 0) {
          log("auto-commit", message);
        }
      });
    });
  });
}
