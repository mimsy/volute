import { command } from "../../lib/command.js";
import { daemonFetch } from "../../lib/daemon-client.js";
import { promptLine } from "../../lib/prompt.js";

const cmd = command({
  name: "volute systems register",
  description: "Register a system on volute.systems",
  flags: {
    name: { type: "string", description: "System name" },
  },
  run: async ({ flags }) => {
    let name = flags.name;
    if (!name) {
      if (!process.stdin.isTTY) {
        console.error("Usage: volute systems register --name <system-name>");
        process.exit(1);
      }
      name = await promptLine("Choose a system name: ");
      if (!name) {
        console.error("No name provided.");
        process.exit(1);
      }
    }

    const res = await daemonFetch("/api/system/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
        error: string;
      };
      console.error(`Registration failed: ${body.error}`);
      process.exit(1);
    }

    const { system } = (await res.json()) as { system: string };
    console.log(`Registered as "${system}". Credentials saved.`);
  },
});

export const run = cmd.execute;
