import { command } from "../../lib/command.js";
import { daemonFetch } from "../../lib/daemon-client.js";
import { resolveMindName } from "../../lib/resolve-mind-name.js";

const cmd = command({
  name: "volute chat accept",
  description: "Accept a pending file transfer",
  args: [{ name: "id", required: true, description: "File transfer ID" }],
  flags: {
    mind: { type: "string", description: "Mind name" },
    dest: { type: "string", description: "Destination path" },
  },
  async run({ args, flags }) {
    const mind = resolveMindName(flags);

    const res = await daemonFetch(`/api/minds/${encodeURIComponent(mind)}/files/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: args.id, dest: flags.dest }),
    });

    if (!res.ok) {
      const data = (await res.json()) as { error?: string };
      console.error(data.error ?? `Failed to accept file: ${res.status}`);
      process.exit(1);
    }

    const data = (await res.json()) as { destPath: string };
    console.log(`File accepted: ${data.destPath}`);
  },
});

export const run = cmd.execute;
