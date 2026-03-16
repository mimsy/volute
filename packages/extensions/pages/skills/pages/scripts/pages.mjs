#!/usr/bin/env node
/**
 * pages.mjs — notify the daemon that a page was created or updated
 *
 * Usage:
 *   node .claude/skills/pages/scripts/pages.mjs notify [filename]
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const mind = process.env.VOLUTE_MIND;
const port = process.env.VOLUTE_DAEMON_PORT;
const token = process.env.VOLUTE_DAEMON_TOKEN;
const mindDir = process.env.VOLUTE_MIND_DIR;

// Read session from env or file (sandbox doesn't propagate env vars set after process start)
let session = process.env.VOLUTE_SESSION;
if (!session && mindDir) {
  try {
    const p = resolve(mindDir, ".mind", "current-session");
    if (existsSync(p)) session = readFileSync(p, "utf-8").trim() || undefined;
  } catch {
    /* best-effort */
  }
}

if (!mind || !port || !token) {
  console.error("Missing VOLUTE_MIND, VOLUTE_DAEMON_PORT, or VOLUTE_DAEMON_TOKEN");
  process.exit(1);
}

const baseUrl = `http://localhost:${port}/api/ext/pages`;
const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${token}`,
  ...(session ? { "X-Volute-Session": session } : {}),
};

const [, , command, ...args] = process.argv;

if (command === "notify") {
  const file = args[0] || "page";
  const res = await fetch(`${baseUrl}/notify`, {
    method: "POST",
    headers,
    body: JSON.stringify({ file }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    console.error(`Failed to notify: ${data.error || res.status}`);
    process.exit(1);
  }
  console.log(`Notified: ${file}`);
} else {
  console.error("Usage: pages.mjs notify [filename]");
  process.exit(1);
}
