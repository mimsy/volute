#!/usr/bin/env bun
import { spawn } from "child_process";
import { readFileSync, unlinkSync, existsSync } from "fs";
import { execSync } from "child_process";
import { resolve } from "path";

const projectRoot = process.cwd();
const restartSignalPath = resolve(projectRoot, ".molt/restart.json");

function startAgent(): ReturnType<typeof spawn> {
  console.error(`[supervisor] starting agent server...`);
  return spawn("bun", ["run", "src/server.ts"], {
    cwd: projectRoot,
    stdio: "inherit",
  });
}

function handleRestart(): boolean {
  if (!existsSync(restartSignalPath)) return false;

  try {
    const signal = JSON.parse(readFileSync(restartSignalPath, "utf-8"));
    unlinkSync(restartSignalPath);

    if (signal.action === "merge" && signal.branch) {
      console.error(`[supervisor] merging branch: ${signal.branch}`);
      try {
        execSync(`git merge ${signal.branch}`, { cwd: projectRoot, stdio: "inherit" });
      } catch (e) {
        console.error(`[supervisor] merge failed:`, e);
        return true; // still restart even if merge fails
      }

      // Clean up the worktree and branch
      if (signal.worktree_id) {
        const wtPath = resolve(projectRoot, ".worktrees", signal.worktree_id);
        try {
          execSync(`git worktree remove --force ${wtPath}`, { cwd: projectRoot, stdio: "pipe" });
        } catch {}
        try {
          execSync(`git branch -D ${signal.branch}`, { cwd: projectRoot, stdio: "pipe" });
        } catch {}
      }

      // Reinstall dependencies in case they changed
      try {
        execSync("bun install", { cwd: projectRoot, stdio: "inherit" });
      } catch (e) {
        console.error(`[supervisor] bun install failed:`, e);
      }
    }

    return true;
  } catch (e) {
    console.error(`[supervisor] failed to read restart signal:`, e);
    return false;
  }
}

function run() {
  const child = startAgent();

  child.on("exit", (code) => {
    console.error(`[supervisor] agent exited with code ${code}`);

    const wasRestart = handleRestart();
    if (wasRestart) {
      console.error(`[supervisor] restarting immediately after merge`);
      run();
    } else {
      console.error(`[supervisor] crash recovery — restarting in 3s`);
      setTimeout(run, 3000);
    }
  });
}

run();
