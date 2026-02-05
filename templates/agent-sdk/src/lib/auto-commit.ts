import { watch, type FSWatcher } from "fs";
import { spawn } from "child_process";
import { log } from "./logger.js";

/**
 * Watch a directory for changes and auto-commit them.
 * Debounces rapid changes to batch them into single commits.
 */
export function startAutoCommit(dir: string, debounceMs = 2000): () => void {
  let timeout: NodeJS.Timeout | null = null;
  let changedFiles = new Set<string>();
  let watcher: FSWatcher | null = null;

  function commit() {
    if (changedFiles.size === 0) return;

    const files = Array.from(changedFiles);
    changedFiles.clear();

    // Run git add and commit
    const gitAdd = spawn("git", ["add", ...files], { cwd: dir });
    gitAdd.on("close", (code) => {
      if (code !== 0) {
        log("auto-commit", "git add failed");
        return;
      }

      // Check if there are staged changes
      const gitDiff = spawn("git", ["diff", "--cached", "--quiet"], { cwd: dir });
      gitDiff.on("close", (diffCode) => {
        if (diffCode === 0) {
          // No changes to commit
          return;
        }

        const message = files.length === 1
          ? `Update ${files[0]}`
          : `Update ${files.length} files`;

        const gitCommit = spawn("git", ["commit", "-m", message], { cwd: dir });
        gitCommit.on("close", (commitCode) => {
          if (commitCode === 0) {
            log("auto-commit", message);
          }
        });
      });
    });
  }

  function onChange(filename: string | null) {
    if (!filename) return;

    // Ignore .git directory and hidden files
    if (filename.startsWith(".git") || filename.startsWith(".")) return;

    changedFiles.add(filename);

    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(commit, debounceMs);
  }

  try {
    watcher = watch(dir, { recursive: true }, (_event, filename) => {
      onChange(filename);
    });
    log("auto-commit", `watching ${dir}`);
  } catch (err) {
    log("auto-commit", "failed to start watcher:", err);
  }

  return () => {
    if (timeout) clearTimeout(timeout);
    if (watcher) watcher.close();
  };
}
