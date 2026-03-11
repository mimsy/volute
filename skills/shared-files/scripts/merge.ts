#!/usr/bin/env tsx
/**
 * Merge the mind's shared branch into main via the daemon API.
 * Usage: tsx merge.ts "commit message"
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const message = process.argv[2];
if (!message) {
  console.error('Usage: tsx merge.ts "commit message"');
  process.exit(1);
}

const mind = process.env.VOLUTE_MIND;
const port = process.env.VOLUTE_DAEMON_PORT;
const token = process.env.VOLUTE_DAEMON_TOKEN;

if (!mind || !port || !token) {
  console.error("Missing VOLUTE_MIND, VOLUTE_DAEMON_PORT, or VOLUTE_DAEMON_TOKEN");
  process.exit(1);
}

// Commit any pending changes in the worktree first
const worktree = resolve("shared");
const status = execFileSync("git", ["status", "--porcelain"], {
  cwd: worktree,
  encoding: "utf-8",
}).trim();
if (status) {
  execFileSync("git", ["add", "-A"], { cwd: worktree, stdio: "ignore" });
  execFileSync("git", ["commit", "--author", `${mind} <${mind}@volute>`, "-m", `wip: ${mind}`], {
    cwd: worktree,
    stdio: "ignore",
  });
}

// Call daemon merge endpoint
const url = `http://localhost:${port}/api/minds/${encodeURIComponent(mind)}/shared/merge`;
const res = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ message }),
});

if (!res.ok) {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  console.error(body.error ?? `Server responded with ${res.status}`);
  process.exit(1);
}

const result = (await res.json()) as { ok: boolean; conflicts?: boolean; message?: string };
if (result.conflicts) {
  console.error("Merge conflicts detected. Pull the latest changes, reconcile, and try again.");
  process.exit(1);
}
console.log(result.message ?? "Merged successfully.");
