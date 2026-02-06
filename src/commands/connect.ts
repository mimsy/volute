import { daemonFetch } from "../lib/daemon-client.js";
import { loadMergedEnv } from "../lib/env.js";
import { parseArgs } from "../lib/parse-args.js";
import { resolveAgent } from "../lib/registry.js";

export async function run(args: string[]) {
  const { positional } = parseArgs(args, {});

  const type = positional[0];
  const name = positional[1];

  if (!type || !name) {
    console.error("Usage: volute connect <type> <agent>");
    process.exit(1);
  }

  const { dir } = resolveAgent(name);

  // Build config from env vars based on connector type
  let config: Record<string, string>;
  if (type === "discord") {
    const env = loadMergedEnv(dir);
    if (!env.DISCORD_TOKEN) {
      console.error("DISCORD_TOKEN not set. Run: volute env set DISCORD_TOKEN <token>");
      process.exit(1);
    }
    config = { token: env.DISCORD_TOKEN };
    if (env.DISCORD_GUILD_ID) config.guildId = env.DISCORD_GUILD_ID;
  } else {
    console.error(`Unknown connector type: ${type}`);
    process.exit(1);
  }

  const res = await daemonFetch(`/api/agents/${name}/connectors/${type}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Unknown error" }));
    console.error(`Failed to start ${type} connector: ${(body as { error: string }).error}`);
    process.exit(1);
  }

  console.log(`${type} connector for ${name} started.`);
}
