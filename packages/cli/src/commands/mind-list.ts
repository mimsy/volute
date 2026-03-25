import { command } from "../lib/command.js";
import { daemonFetch } from "../lib/daemon-client.js";

const cmd = command({
  name: "volute mind list",
  description: "List all minds",
  flags: {},
  async run() {
    const res = await daemonFetch("/api/minds");
    if (!res.ok) {
      const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
        error: string;
      };
      console.error(`Failed to list minds: ${body.error}`);
      process.exit(1);
    }

    const minds = (await res.json()) as Array<{
      name: string;
      running: boolean;
      status?: string;
      stage?: string;
    }>;

    if (minds.length === 0) {
      console.log("No minds configured.");
      return;
    }

    for (const mind of minds) {
      const status = mind.status ?? (mind.running ? "running" : "stopped");
      const label = mind.stage === "seed" ? " (seed)" : "";
      console.log(`  ${mind.name}: ${status}${label}`);
    }
  },
});

export const run = cmd.execute;
