import { command } from "../lib/command.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

const cmd = command({
  name: "volute clock sleep",
  description: "Put a mind to sleep",
  args: [{ name: "name", description: "Mind to sleep (or use --mind / VOLUTE_MIND)" }],
  flags: {
    mind: { type: "string", description: "Mind name" },
    "wake-at": { type: "string", description: "Schedule wake time" },
  },
  run: async ({ args, flags }) => {
    const name = args.name || resolveMindName(flags as { mind?: string });
    if (!name) {
      console.error("Provide a mind name as argument, --mind flag, or VOLUTE_MIND env var");
      process.exit(1);
    }

    const body: Record<string, string> = {};
    if (flags["wake-at"]) body.wakeAt = flags["wake-at"] as string;

    const res = await daemonFetch(`/api/minds/${encodeURIComponent(name)}/sleep`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = (await res.json()) as { ok?: boolean; error?: string };

    if (!res.ok) {
      console.error(data.error || "Failed to put mind to sleep");
      process.exit(1);
    }

    console.log(`${name} is going to sleep`);
  },
});

export const run = cmd.execute;
