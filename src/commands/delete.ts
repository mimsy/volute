import { parseArgs } from "../lib/parse-args.js";
import { resolveAgentName } from "../lib/resolve-agent-name.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    force: { type: "boolean" },
  });

  const name = resolveAgentName({ agent: positional[0] });

  const { daemonFetch } = await import("../lib/daemon-client.js");
  const { getClient, urlOf } = await import("../lib/api-client.js");
  const client = getClient();

  const url =
    urlOf(client.api.agents[":name"].$url({ param: { name } })) +
    (flags.force ? "?force=true" : "");

  const res = await daemonFetch(url, { method: "DELETE" });

  const data = (await res.json()) as { ok?: boolean; error?: string };

  if (!res.ok) {
    console.error(data.error ?? "Failed to delete agent");
    process.exit(1);
  }

  console.log(`Removed ${name}.`);
  if (flags.force) {
    console.log("Deleted agent directory.");
  } else {
    console.log("Use --force to also delete the agent directory.");
  }
}
