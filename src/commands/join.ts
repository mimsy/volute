import { parseArgs } from "../lib/parse-args.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    summary: { type: "string" },
    justification: { type: "string" },
    memory: { type: "string" },
    "skip-verify": { type: "boolean" },
  });

  const splitName = positional[0];
  if (!splitName) {
    console.error(
      "Usage: volute mind join <split-name> [--summary '...'] [--justification '...'] [--memory '...'] [--skip-verify]",
    );
    process.exit(1);
  }

  console.log(`Joining split ${splitName}...`);

  const { daemonFetch } = await import("../lib/daemon-client.js");
  const { getClient, urlOf } = await import("../lib/api-client.js");

  const client = getClient();
  // The split name is used to look up its parent in the DB
  // The API endpoint still uses the parent mind name + variant name
  // So we need to resolve the split's parent first
  const statusRes = await daemonFetch(
    urlOf(client.api.minds[":name"].$url({ param: { name: splitName } })),
  );

  if (!statusRes.ok) {
    console.error(`Split '${splitName}' not found`);
    process.exit(1);
  }

  const statusData = (await statusRes.json()) as { parent?: string };
  const parentName = statusData.parent;

  if (!parentName) {
    console.error(`'${splitName}' is not a split — it has no parent mind`);
    process.exit(1);
  }

  const res = await daemonFetch(
    urlOf(
      client.api.minds[":name"].variants[":variant"].merge.$url({
        param: { name: parentName, variant: splitName },
      }),
    ),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(flags.summary && { summary: flags.summary }),
        ...(flags.justification && { justification: flags.justification }),
        ...(flags.memory && { memory: flags.memory }),
        ...(flags["skip-verify"] && { skipVerify: true }),
      }),
    },
  );

  const data = (await res.json()) as { ok?: boolean; error?: string };

  if (!res.ok) {
    console.error(data.error ?? "Failed to join split");
    process.exit(1);
  }

  console.log(`Split ${splitName} joined and cleaned up.`);
}
