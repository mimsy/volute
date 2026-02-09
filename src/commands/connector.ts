import { daemonFetch } from "../lib/daemon-client.js";
import { loadMergedEnv } from "../lib/env.js";
import { parseArgs } from "../lib/parse-args.js";
import { resolveAgent } from "../lib/registry.js";
import { resolveAgentName } from "../lib/resolve-agent-name.js";

export async function run(args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case "connect":
      await connectConnector(args.slice(1));
      break;
    case "disconnect":
      await disconnectConnector(args.slice(1));
      break;
    default:
      printUsage();
      process.exit(subcommand ? 1 : 0);
  }
}

function printUsage() {
  console.error(`Usage:
  volute connector connect <type> [--agent <name>]
  volute connector disconnect <type> [--agent <name>]`);
}

async function connectConnector(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    agent: { type: "string" },
  });

  const agentName = resolveAgentName(flags);
  const type = positional[0];

  if (!type) {
    console.error("Usage: volute connector connect <type> [--agent <name>]");
    process.exit(1);
  }

  const { dir } = resolveAgent(agentName);

  // Validate required env vars for the connector type
  if (type === "discord") {
    const env = loadMergedEnv(dir);
    if (!env.DISCORD_TOKEN) {
      console.error("DISCORD_TOKEN not set. Run: volute env set DISCORD_TOKEN <token>");
      process.exit(1);
    }
  } else {
    console.error(`Unknown connector type: ${type}`);
    process.exit(1);
  }

  const res = await daemonFetch(
    `/api/agents/${encodeURIComponent(agentName)}/connectors/${encodeURIComponent(type)}`,
    { method: "POST" },
  );

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Unknown error" }));
    console.error(`Failed to start ${type} connector: ${(body as { error: string }).error}`);
    process.exit(1);
  }

  console.log(`${type} connector for ${agentName} started.`);
}

async function disconnectConnector(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    agent: { type: "string" },
  });

  const agentName = resolveAgentName(flags);
  const type = positional[0];

  if (!type) {
    console.error("Usage: volute connector disconnect <type> [--agent <name>]");
    process.exit(1);
  }

  const res = await daemonFetch(
    `/api/agents/${encodeURIComponent(agentName)}/connectors/${encodeURIComponent(type)}`,
    {
      method: "DELETE",
    },
  );

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Unknown error" }));
    console.error(`Failed to stop ${type} connector: ${(body as { error: string }).error}`);
    process.exit(1);
  }

  console.log(`${type} connector for ${agentName} stopped.`);
}
