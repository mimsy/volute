import { parseArgs } from "../lib/parse-args.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    summary: { type: "string" },
    justification: { type: "string" },
    memory: { type: "string" },
    "skip-verify": { type: "boolean" },
  });

  const variantName = positional[0];
  if (!variantName) {
    console.error(
      "Usage: volute mind join <variant-name> [--summary '...'] [--justification '...'] [--memory '...'] [--skip-verify]",
    );
    process.exit(1);
  }

  console.log(`Joining variant ${variantName}...`);

  const { daemonFetch } = await import("../lib/daemon-client.js");
  const { getClient, urlOf } = await import("../lib/api-client.js");

  const client = getClient();
  // The variant name is used to look up its parent in the DB
  // The API endpoint still uses the parent mind name + variant name
  // So we need to resolve the variant's parent first
  const statusRes = await daemonFetch(
    urlOf(client.api.minds[":name"].$url({ param: { name: variantName } })),
  );

  if (!statusRes.ok) {
    const data = (await statusRes.json().catch(() => ({}))) as { error?: string };
    console.error(data.error ?? `Variant '${variantName}' not found (HTTP ${statusRes.status})`);
    process.exit(1);
  }

  const statusData = (await statusRes.json()) as { parent?: string };
  const parentName = statusData.parent;

  if (!parentName) {
    console.error(`'${variantName}' is not a variant — it has no parent mind`);
    process.exit(1);
  }

  const res = await daemonFetch(
    urlOf(
      client.api.minds[":name"].variants[":variant"].merge.$url({
        param: { name: parentName, variant: variantName },
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
    console.error(data.error ?? "Failed to join variant");
    process.exit(1);
  }

  console.log(`Variant ${variantName} joined and cleaned up.`);
}
