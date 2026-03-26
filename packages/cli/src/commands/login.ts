import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { voluteUserHome } from "@volute/daemon/lib/mind/registry.js";
import { command } from "../lib/command.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { promptLine, promptPassword } from "../lib/prompt.js";

const cmd = command({
  name: "volute login",
  description: "Log in to the daemon",
  flags: {},
  run: async () => {
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
      const sessionData: Record<string, string> = { sessionId, username: name };
      const daemonUrl = process.env.VOLUTE_DAEMON_URL;
      if (daemonUrl) sessionData.daemonUrl = daemonUrl;
      writeFileSync(sessionPath, JSON.stringify(sessionData), { mode: 0o600 });
    } catch (err) {
      console.error(`Login succeeded but failed to save session: ${(err as Error).message}`);
      process.exit(1);
    }

    console.log(`Logged in as ${name} (role: ${role})`);
  },
});

export const run = cmd.execute;
