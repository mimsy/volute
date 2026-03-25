import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { voluteUserHome } from "@volute/daemon/lib/registry.js";
import { command } from "../lib/command.js";
import { daemonFetch } from "../lib/daemon-client.js";

const cmd = command({
  name: "volute logout",
  description: "Log out of the daemon",
  flags: {},
  run: async () => {
    const sessionPath = resolve(voluteUserHome(), "cli-session.json");

    if (!existsSync(sessionPath)) {
      console.log("Not logged in");
      return;
    }

    let sessionId: string | undefined;
    try {
      const data = JSON.parse(readFileSync(sessionPath, "utf-8"));
      sessionId = data.sessionId;
    } catch {
      // Corrupt file — just delete it
    }

    if (sessionId) {
      try {
        await daemonFetch("/api/auth/logout", {
          method: "POST",
          headers: { Authorization: `Bearer ${sessionId}` },
        });
      } catch {
        // Best effort — session may already be expired
      }
    }

    unlinkSync(sessionPath);
    console.log("Logged out");
  },
});

export const run = cmd.execute;
