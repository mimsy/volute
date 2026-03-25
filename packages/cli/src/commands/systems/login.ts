import { command } from "../../lib/command.js";
import { daemonFetch } from "../../lib/daemon-client.js";
import { promptLine } from "../../lib/prompt.js";

const cmd = command({
  name: "volute systems login",
  description: "Log in with an existing API key",
  flags: {
    key: { type: "string", description: "API key" },
  },
  run: async ({ flags }) => {
    let key = flags.key;
    if (!key) {
      if (!process.stdin.isTTY) {
        console.error("Usage: volute systems login --key <api-key>");
        process.exit(1);
      }
      key = await promptLine("API key: ");
      if (!key) {
        console.error("No key provided.");
        process.exit(1);
      }
    }

    const res = await daemonFetch("/api/system/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
        error: string;
      };
      console.error(`Login failed: ${body.error}`);
      process.exit(1);
    }

    const { system } = (await res.json()) as { system: string };
    console.log(`Logged in as "${system}". Credentials saved.`);
  },
});

export const run = cmd.execute;
