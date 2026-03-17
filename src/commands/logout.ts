import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { daemonFetch } from "../lib/daemon-client.js";
import { voluteUserHome } from "../lib/registry.js";

export async function run(_args: string[]): Promise<void> {
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
}
