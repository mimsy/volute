import { command } from "../../lib/command.js";
import { daemonFetch } from "../../lib/daemon-client.js";
import { resolveMindName } from "../../lib/resolve-mind-name.js";

const cmd = command({
  name: "volute chat reject",
  description: "Reject a pending file transfer",
  args: [{ name: "id", required: true, description: "File transfer ID" }],
  flags: {
    mind: { type: "string", description: "Mind name" },
  },
  async run({ args, flags }) {
    const mind = resolveMindName(flags);

    const res = await daemonFetch(`/api/minds/${encodeURIComponent(mind)}/files/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: args.id }),
    });

    if (!res.ok) {
      const data = (await res.json()) as { error?: string };
      console.error(data.error ?? `Failed to reject file: ${res.status}`);
      process.exit(1);
    }

    console.log(`File rejected: ${args.id}`);
  },
});

export const run = cmd.execute;
