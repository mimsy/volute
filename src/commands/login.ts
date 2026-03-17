import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { daemonFetch } from "../lib/daemon-client.js";
import { promptLine, promptPassword } from "../lib/prompt.js";
import { voluteUserHome } from "../lib/registry.js";

export async function run(_args: string[]): Promise<void> {
  const username = await promptLine("Username: ");
  const password = await promptPassword("Password: ");

  const res = await daemonFetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    console.error(data.error || "Login failed");
    process.exit(1);
  }

  const {
    username: name,
    role,
    sessionId,
  } = (await res.json()) as {
    username: string;
    role: string;
    sessionId: string;
  };

  const sessionPath = resolve(voluteUserHome(), "cli-session.json");
  try {
    writeFileSync(sessionPath, JSON.stringify({ sessionId, username: name }), { mode: 0o600 });
  } catch (err) {
    console.error(`Login succeeded but failed to save session: ${(err as Error).message}`);
    process.exit(1);
  }

  console.log(`Logged in as ${name} (role: ${role})`);
}
