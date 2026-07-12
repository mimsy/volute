import { command } from "../lib/command.js";

const cmd = command({
  name: "volute seed check",
  description: "Check seed readiness",
  args: [{ name: "name", required: true, description: "Seed mind to check" }],
  flags: {
    nurture: {
      type: "boolean",
      description:
        "Apply the nurture gate (used by the spirit's schedule): stay silent when no nudge is needed",
    },
  },
  run: async ({ args, flags }) => {
    const name = args.name!;

    // A bare, host-facing check always prints the readiness state. Only the
    // spirit's nurture schedule (--nurture) keeps the recency gate that stays
    // quiet when the seed was recently attended to (#666).
    const query = flags.nurture ? "" : "?force=1";

    const { daemonFetch } = await import("../lib/daemon-client.js");
    const res = await daemonFetch(`/api/minds/${encodeURIComponent(name)}/seed-check${query}`);

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
