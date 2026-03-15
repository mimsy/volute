#!/usr/bin/env node
/**
 * pages.mjs — notify the daemon that a page was created or updated
 *
 * Usage:
 *   node .claude/skills/pages/scripts/pages.mjs notify [filename]
 */

const mind = process.env.VOLUTE_MIND;
const port = process.env.VOLUTE_DAEMON_PORT;
const token = process.env.VOLUTE_DAEMON_TOKEN;
const session = process.env.VOLUTE_SESSION;

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
