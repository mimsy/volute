import { getClient, urlOf } from "../lib/api-client.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { resolveMind } from "../lib/registry.js";

export async function run(args: string[]) {
  const name = args[0];
  if (!name) {
    console.error("Usage: volute mind start <name>");
    process.exit(1);
  }

  const { entry } = resolveMind(name);
  const client = getClient();

  const res = await daemonFetch(urlOf(client.api.minds[":name"].start.$url({ param: { name } })), {
    method: "POST",
  });

  const data = (await res.json()) as { ok?: boolean; error?: string };

  if (!res.ok) {
    console.error(data.error || "Failed to start mind");
    process.exit(1);
  }

  console.log(`${name} started on port ${entry.port}`);
}
