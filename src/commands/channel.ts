import { parseArgs } from "../lib/parse-args.js";
import { resolveAgent } from "../lib/registry.js";
import { loadMergedEnv } from "../lib/env.js";
import * as discord from "../lib/channels/discord.js";

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
  molt channel read <channel-uri> [--limit N] [--agent <name>]
  molt channel send <channel-uri> "<message>" [--agent <name>]`);
    process.exit(1);
  }

  const agentName = flags.agent || process.env.MOLT_AGENT;
  if (!agentName) {
    console.error(
      "No agent specified. Use --agent <name> or run from within an agent process.",
    );
    process.exit(1);
  }

  const colonIdx = uri.indexOf(":");
  if (colonIdx === -1) {
    console.error(`Invalid channel URI: ${uri} (expected format: platform:id)`);
    process.exit(1);
  }

  const platform = uri.slice(0, colonIdx);
  const channelId = uri.slice(colonIdx + 1);

  const { dir } = resolveAgent(agentName);
  const env = loadMergedEnv(dir);

  if (platform === "discord") {
    const token = env.DISCORD_TOKEN;
    if (!token) {
      console.error(
        "DISCORD_TOKEN not set. Run: molt env set DISCORD_TOKEN <token>",
      );
      process.exit(1);
    }

    if (subcommand === "read") {
      const limit = flags.limit ?? 20;
      const output = await discord.read(token, channelId, limit);
      console.log(output);
    } else if (subcommand === "send") {
      await discord.send(token, channelId, message!);
    } else {
      console.error(`Unknown subcommand: ${subcommand}`);
      process.exit(1);
    }
  } else {
    console.error(`Unsupported platform: ${platform}`);
    process.exit(1);
  }
}
