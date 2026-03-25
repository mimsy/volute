import { getClient, urlOf } from "../lib/api-client.js";
import { command } from "../lib/command.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

const cmd = command({
  name: "volute mind restart",
  description: "Restart a mind",
  args: [{ name: "name", description: "Mind to restart (or use VOLUTE_MIND)" }],
  flags: {},
  async run({ args }) {
    const name = resolveMindName({ mind: args.name });

    const client = getClient();

    const res = await daemonFetch(
      urlOf(client.api.minds[":name"].restart.$url({ param: { name } })),
      { method: "POST" },
    );

    const data = (await res.json()) as { ok?: boolean; error?: string; port?: number };

    if (!res.ok) {
      console.error(data.error || "Failed to restart mind");
      process.exit(1);
    }

    console.log(`${name} restarted on port ${data.port}`);
  },
});

export const run = cmd.execute;
