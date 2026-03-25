import { getClient, urlOf } from "../lib/api-client.js";
import { command } from "../lib/command.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

const cmd = command({
  name: "volute mind stop",
  description: "Stop a mind",
  args: [{ name: "name", description: "Mind to stop (or use VOLUTE_MIND)" }],
  flags: {},
  async run({ args }) {
    const name = resolveMindName({ mind: args.name });

    const client = getClient();

    const res = await daemonFetch(urlOf(client.api.minds[":name"].stop.$url({ param: { name } })), {
      method: "POST",
    });

    const data = (await res.json()) as { ok?: boolean; error?: string };

    if (!res.ok) {
      console.error(data.error || "Failed to stop mind");
      process.exit(1);
    }

    console.log(`${name} stopped.`);
  },
});

export const run = cmd.execute;
