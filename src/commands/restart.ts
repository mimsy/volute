import { getClient, urlOf } from "../lib/api-client.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { resolveAgent } from "../lib/registry.js";
import { resolveAgentName } from "../lib/resolve-agent-name.js";

export async function run(args: string[]) {
  const name = resolveAgentName({ agent: args[0] });

  const { entry } = resolveAgent(name);
  const client = getClient();

  const res = await daemonFetch(
    urlOf(client.api.agents[":name"].restart.$url({ param: { name } })),
    { method: "POST" },
  );

  const data = (await res.json()) as { ok?: boolean; error?: string };

  if (!res.ok) {
    console.error(data.error || "Failed to restart agent");
    process.exit(1);
  }

  console.log(`${name} restarted on port ${entry.port}`);
}
