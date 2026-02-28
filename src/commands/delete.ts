import { parseArgs } from "@volute/shared/parse-args";
import { resolveMindName } from "../lib/resolve-mind-name.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    force: { type: "boolean" },
  });

  const name = resolveMindName({ mind: positional[0] });

  const { daemonFetch } = await import("../lib/daemon-client.js");
  const { getClient, urlOf } = await import("../lib/api-client.js");
  const client = getClient();

  const url =
    urlOf(client.api.minds[":name"].$url({ param: { name } })) + (flags.force ? "?force=true" : "");

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
}
