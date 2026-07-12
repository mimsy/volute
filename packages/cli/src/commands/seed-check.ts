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

    // A bare, host-facing check always prints the readiness state. The spirit's
    // nurture schedule passes --nurture to keep the recency gate that stays
    // quiet when the seed was recently attended to (#666). Nurture schedules
    // written before this flag existed run the bare form and report every fire
    // until the seed sprouts.
    const query = flags.nurture ? "" : "?force=1";

    const { daemonFetch } = await import("../lib/daemon-client.js");
    const res = await daemonFetch(`/api/minds/${encodeURIComponent(name)}/seed-check${query}`);

    if (!res.ok) {
      // Non-zero exit so the scheduler surfaces failures instead of logging
      // them as an empty (gated) result.
      process.exitCode = 1;
      if (res.status === 404) {
        console.error(`Seed "${name}" not found — it may have been deleted.`);
      } else {
        console.error(`seed check failed for ${name}: HTTP ${res.status}`);
      }
      return;
    }

    const data = (await res.json()) as { output?: string };
    if (data.output) {
      console.log(data.output);
    } else if (!flags.nurture) {
      // A forced check always returns output from a current daemon; report
      // rather than exit silently if something upstream ignored ?force=1.
      console.log(`No readiness output returned for ${name}.`);
    }
  },
});

export const run = cmd.execute;
