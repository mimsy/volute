import { getClient, urlOf } from "../lib/api-client.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { resolveMind } from "../lib/registry.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

export async function run(args: string[]) {
  const name = resolveMindName({ mind: args[0] });

  resolveMind(name); // Validate mind exists
  const client = getClient();

  const res = await daemonFetch(urlOf(client.api.minds[":name"].stop.$url({ param: { name } })), {
    method: "POST",
  });

  const data = (await res.json()) as { ok?: boolean; error?: string };

  if (!res.ok) {
    console.error(data.error || "Failed to stop mind");
    process.exit(1);
  }

  console.log(`${name} stopped.`);
}
