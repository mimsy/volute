import { getChannelDriver } from "../lib/channels.js";
import { loadMergedEnv } from "../lib/env.js";
import { parseArgs } from "../lib/parse-args.js";
import { resolveAgent } from "../lib/registry.js";
import { resolveAgentName } from "../lib/resolve-agent-name.js";

export async function run(args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case "read":
      await readChannel(args.slice(1));
      break;
    case "send":
      await sendChannel(args.slice(1));
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
  volute channel read <channel-uri> [--limit N] [--agent <name>]
  volute channel send <channel-uri> "<message>" [--agent <name>]`);
}

async function readChannel(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    agent: { type: "string" },
    limit: { type: "number" },
  });

  const uri = positional[0];
  if (!uri) {
    console.error("Usage: volute channel read <channel-uri> [--limit N] [--agent <name>]");
    process.exit(1);
  }

  const agentName = resolveAgentName(flags);
  const { platform, channelId } = parseUri(uri);
  const driver = requireDriver(platform);
  const { dir } = resolveAgent(agentName);
  const env = loadMergedEnv(dir);

  try {
    const limit = flags.limit ?? 20;
    const output = await driver.read(env, channelId, limit);
    console.log(output);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function sendChannel(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    agent: { type: "string" },
  });

  const uri = positional[0];
  const message = positional[1];
  if (!uri || !message) {
    console.error('Usage: volute channel send <channel-uri> "<message>" [--agent <name>]');
    process.exit(1);
  }

  const agentName = resolveAgentName(flags);
  const { platform, channelId } = parseUri(uri);
  const driver = requireDriver(platform);
  const { dir } = resolveAgent(agentName);
  const env = loadMergedEnv(dir);

  try {
    await driver.send(env, channelId, message);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

function parseUri(uri: string): { platform: string; channelId: string } {
  const colonIdx = uri.indexOf(":");
  if (colonIdx === -1) {
    console.error(`Invalid channel URI: ${uri} (expected format: platform:id)`);
    process.exit(1);
  }
  return { platform: uri.slice(0, colonIdx), channelId: uri.slice(colonIdx + 1) };
}

function requireDriver(platform: string) {
  const driver = getChannelDriver(platform);
  if (!driver) {
    console.error(`No channel driver for platform: ${platform}`);
    process.exit(1);
  }
  return driver;
}
