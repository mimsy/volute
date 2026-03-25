import { command } from "../lib/command.js";

const cmd = command({
  name: "volute seed check",
  description: "Check seed readiness",
  args: [{ name: "name", required: true, description: "Seed mind to check" }],
  flags: {},
  run: async ({ args }) => {
    const name = args.name!;

    const { daemonFetch } = await import("../lib/daemon-client.js");
    const res = await daemonFetch(`/api/minds/${encodeURIComponent(name)}/seed-check`);

    if (!res.ok) {
      if (res.status === 404) {
        console.log(`Seed "${name}" not found — it may have been deleted or already sprouted.`);
      } else {
        console.error(`seed check failed for ${name}: HTTP ${res.status}`);
      }
      return;
    }

    const data = (await res.json()) as { output?: string };
    if (data.output) {
      console.log(data.output);
    }
  },
});

export const run = cmd.execute;
