import { command } from "../lib/command.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

const cmd = command({
  name: "volute clock wake",
  description: "Wake a sleeping mind",
  args: [{ name: "name", description: "Mind to wake (or use --mind / VOLUTE_MIND)" }],
  flags: {
    mind: { type: "string", description: "Mind name" },
  },
  run: async ({ args, flags }) => {
    const name = args.name || resolveMindName(flags as { mind?: string });
    if (!name) {
      console.error("Provide a mind name as argument, --mind flag, or VOLUTE_MIND env var");
      process.exit(1);
    }

    const res = await daemonFetch(`/api/minds/${encodeURIComponent(name)}/wake`, {
      method: "POST",
    });

    const data = (await res.json()) as { ok?: boolean; error?: string };

    if (!res.ok) {
      console.error(data.error || "Failed to wake mind");
      process.exit(1);
    }

    console.log(`${name} is waking up`);
  },
});

export const run = cmd.execute;
