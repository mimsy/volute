import { getClient, urlOf } from "../lib/api-client.js";
import { command } from "../lib/command.js";
import { daemonFetch } from "../lib/daemon-client.js";

const cmd = command({
  name: "volute mind start",
  description: "Start a mind",
  args: [{ name: "name", required: true, description: "Mind to start" }],
  flags: {},
  async run({ args }) {
    const name = args.name!;

    const client = getClient();

    const res = await daemonFetch(
      urlOf(client.api.minds[":name"].start.$url({ param: { name } })),
      { method: "POST" },
    );

    const data = (await res.json()) as { ok?: boolean; error?: string; port?: number };

    if (!res.ok) {
      console.error(data.error || "Failed to start mind");
      process.exit(1);
    }

    console.log(`${name} started on port ${data.port}`);
  },
});

export const run = cmd.execute;
