import { command } from "../lib/command.js";

const cmd = command({
  name: "volute mind join",
  description: "Merge a variant back into its parent",
  args: [{ name: "variant", required: true, description: "Variant to merge back" }],
  flags: {
    summary: { type: "string", description: "Summary of changes" },
    justification: { type: "string", description: "Justification for merge" },
    memory: { type: "string", description: "Memory to add" },
    "skip-verify": { type: "boolean", description: "Skip verification step" },
    "discard-unresolved": {
      type: "boolean",
      description:
        "Join even if the variant has untracked home/ files git would otherwise refuse to discard",
    },
  },
  run: async ({ args, flags }) => {
    const variantName = args.variant!;

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
          ...(flags["discard-unresolved"] && { discardUnresolved: true }),
        }),
      },
    );

    const data = (await res.json()) as {
      ok?: boolean;
      error?: string;
      conflicts?: string[];
      unresolvedFiles?: { path: string; bytes: number }[];
    };

    if (!res.ok) {
      console.error(data.error ?? "Failed to join variant");
      if (data.conflicts?.length) {
        console.error("\nConflicting files:");
        for (const file of data.conflicts) console.error(`  ${file}`);
      }
      if (data.unresolvedFiles?.length) {
        console.error("\nRetry with --discard-unresolved to join anyway and discard them.");
      }
      process.exit(1);
    }

    console.log(`Variant ${variantName} joined and cleaned up.`);
  },
});

export const run = cmd.execute;
