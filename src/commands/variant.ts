import { parseArgs } from "../lib/parse-args.js";
import { resolveAgent } from "../lib/registry.js";
import { resolveAgentName } from "../lib/resolve-agent-name.js";
import { checkHealth, readVariants, type Variant, writeVariants } from "../lib/variants.js";

export async function run(args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case "create":
      await createVariant(args.slice(1));
      break;
    case "list":
      await listVariants(args.slice(1));
      break;
    case "merge":
      await mergeVariant(args.slice(1));
      break;
    case "delete":
      await deleteVariant(args.slice(1));
      break;
    case "--help":
    case "-h":
    case undefined:
      printUsage();
      break;
    default:
      printUsage();
      process.exit(1);
  }
}

function printUsage() {
  console.log(`Usage:
  volute variant create <variant> [--agent <name>] [--soul "..."] [--port N] [--no-start] [--json]
  volute variant list [--agent <name>] [--json]
  volute variant merge <variant> [--agent <name>] [--summary "..." --memory "..."] [--skip-verify]
  volute variant delete <variant> [--agent <name>]`);
}

async function createVariant(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    agent: { type: "string" },
    soul: { type: "string" },
    port: { type: "number" },
    "no-start": { type: "boolean" },
    json: { type: "boolean" },
  });

  const agentName = resolveAgentName(flags);
  const variantName = positional[0];
  const { soul, port, json } = flags;
  const noStart = flags["no-start"];

  if (!variantName) {
    console.error(
      'Usage: volute variant create <variant> [--agent <name>] [--soul "..."] [--port N] [--no-start] [--json]',
    );
    process.exit(1);
  }

  if (!json) console.log("Creating variant via daemon...");

  const { daemonFetch } = await import("../lib/daemon-client.js");
  const { getClient, urlOf } = await import("../lib/api-client.js");

  const client = getClient();
  const res = await daemonFetch(
    urlOf(client.api.agents[":name"].variants.$url({ param: { name: agentName } })),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: variantName,
        ...(soul && { soul }),
        ...(port && { port }),
        ...(noStart && { noStart }),
      }),
    },
  );

  const data = (await res.json()) as {
    ok?: boolean;
    error?: string;
    variant?: { name: string; branch: string; path: string; port: number };
  };

  if (!res.ok) {
    console.error(data.error ?? "Failed to create variant");
    process.exit(1);
  }

  if (json) {
    console.log(JSON.stringify(data.variant, null, 2));
  } else {
    console.log(`\nVariant created: ${variantName}`);
    console.log(`  Branch: ${data.variant?.branch}`);
    console.log(`  Path:   ${data.variant?.path}`);
    console.log(`  Port:   ${data.variant?.port}`);
  }
}

async function listVariants(args: string[]) {
  const { flags } = parseArgs(args, {
    agent: { type: "string" },
    json: { type: "boolean" },
  });

  const agentName = resolveAgentName(flags);
  const { json } = flags;
  resolveAgent(agentName); // validate agent exists
  const variants = readVariants(agentName);

  if (variants.length === 0) {
    if (json) {
      console.log("[]");
    } else {
      console.log("No variants.");
    }
    return;
  }

  // Health-check all variants in parallel
  const results: (Variant & { status: string })[] = await Promise.all(
    variants.map(async (v) => {
      if (!v.port) return { ...v, status: "no-server" };
      const health = await checkHealth(v.port);
      return { ...v, status: health.ok ? "running" : "dead" };
    }),
  );

  // Update variants.json to clear running status for dead variants
  const updated = results.map(({ status, ...v }) => ({
    ...v,
    running: status === "running",
  }));
  writeVariants(agentName, updated);

  if (json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // Print table
  const nameW = Math.max(4, ...results.map((r) => r.name.length));
  const portW = Math.max(4, ...results.map((r) => String(r.port || "-").length));

  console.log(`${"NAME".padEnd(nameW)}  ${"PORT".padEnd(portW)}  ${"STATUS".padEnd(10)}  BRANCH`);
  for (const r of results) {
    console.log(
      `${r.name.padEnd(nameW)}  ${String(r.port || "-").padEnd(portW)}  ${r.status.padEnd(10)}  ${r.branch}`,
    );
  }
}

async function mergeVariant(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    agent: { type: "string" },
    summary: { type: "string" },
    justification: { type: "string" },
    memory: { type: "string" },
    "skip-verify": { type: "boolean" },
  });

  const agentName = resolveAgentName(flags);
  const variantName = positional[0];
  if (!variantName) {
    console.error(
      "Usage: volute variant merge <variant> [--agent <name>] [--summary '...'] [--justification '...'] [--memory '...'] [--skip-verify]",
    );
    process.exit(1);
  }

  console.log(`Merging variant ${variantName}...`);

  const { daemonFetch } = await import("../lib/daemon-client.js");
  const { getClient, urlOf } = await import("../lib/api-client.js");

  const client = getClient();
  const res = await daemonFetch(
    urlOf(
      client.api.agents[":name"].variants[":variant"].merge.$url({
        param: { name: agentName, variant: variantName },
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
    console.error(data.error ?? "Failed to merge variant");
    process.exit(1);
  }

  console.log(`Variant ${variantName} merged and cleaned up.`);
}

async function deleteVariant(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    agent: { type: "string" },
  });

  const agentName = resolveAgentName(flags);
  const variantName = positional[0];
  if (!variantName) {
    console.error("Usage: volute variant delete <variant> [--agent <name>]");
    process.exit(1);
  }

  const { daemonFetch } = await import("../lib/daemon-client.js");
  const { getClient, urlOf } = await import("../lib/api-client.js");

  const client = getClient();
  const res = await daemonFetch(
    urlOf(
      client.api.agents[":name"].variants[":variant"].$url({
        param: { name: agentName, variant: variantName },
      }),
    ),
    { method: "DELETE" },
  );

  const data = (await res.json()) as { ok?: boolean; error?: string };

  if (!res.ok) {
    console.error(data.error ?? "Failed to delete variant");
    process.exit(1);
  }

  console.log(`Variant ${variantName} deleted.`);
}
