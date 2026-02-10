import { getChannelDriver } from "../lib/channels.js";
import { loadMergedEnv } from "../lib/env.js";
import { parseArgs } from "../lib/parse-args.js";
import { resolveAgent } from "../lib/registry.js";
import { resolveAgentName } from "../lib/resolve-agent-name.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    agent: { type: "string" },
    limit: { type: "number" },
  });

  const subcommand = positional[0];
  const uri = positional[1];
  const message = positional[2];

  if (!subcommand || !uri || (subcommand === "send" && !message)) {
    console.error(`Usage:
  volute channel read <channel-uri> [--limit N] [--agent <name>]
  volute channel send <channel-uri> "<message>" [--agent <name>]`);
    process.exit(1);
  }

  const agentName = resolveAgentName(flags);

  const colonIdx = uri.indexOf(":");
  if (colonIdx === -1) {
    console.error(`Invalid channel URI: ${uri} (expected format: platform:id)`);
    process.exit(1);
  }

  const platform = uri.slice(0, colonIdx);
  const channelId = uri.slice(colonIdx + 1);

  const driver = getChannelDriver(platform);
  if (!driver) {
    console.error(`No channel driver for platform: ${platform}`);
    process.exit(1);
  }

  const { dir } = resolveAgent(agentName);
  const env = loadMergedEnv(dir);

  if (subcommand === "read") {
    const limit = flags.limit ?? 20;
    const output = await driver.read(env, channelId, limit);
    console.log(output);
  } else if (subcommand === "send") {
    await driver.send(env, channelId, message!);
  } else {
    console.error(`Unknown subcommand: ${subcommand}`);
    process.exit(1);
  }
}
