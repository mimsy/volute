import { command } from "../lib/command.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

const cmd = command({
  name: "volute mind delete",
  description: "Delete a mind from the registry",
  args: [{ name: "name", description: "Mind to delete (or use VOLUTE_MIND)" }],
  flags: {
    force: { type: "boolean", description: "Also delete the mind's directory" },
  },
  async run({ args, flags }) {
    const name = resolveMindName({ mind: args.name });

    const { daemonFetch } = await import("../lib/daemon-client.js");
    const { getClient, urlOf } = await import("../lib/api-client.js");
    const client = getClient();

    const url =
      urlOf(client.api.minds[":name"].$url({ param: { name } })) +
      (flags.force ? "?force=true" : "");

    const res = await daemonFetch(url, { method: "DELETE" });

    const data = (await res.json()) as { ok?: boolean; error?: string };

    if (!res.ok) {
      console.error(data.error ?? "Failed to delete mind");
      process.exit(1);
    }

    console.log(`Removed ${name}.`);
    if (flags.force) {
      console.log("Deleted mind directory.");
    } else {
      console.log("Use --force to also delete the mind directory.");
    }
  },
});

export const run = cmd.execute;
