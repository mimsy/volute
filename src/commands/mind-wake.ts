import { daemonFetch } from "../lib/daemon-client.js";
import { parseArgs } from "../lib/parse-args.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    mind: { type: "string" },
  });

  const name = positional[0] || resolveMindName(flags as { mind?: string });
  if (!name) {
    console.error("Usage: volute mind wake <name>");
    process.exit(1);
  }

  const res = await daemonFetch(`/api/minds/${encodeURIComponent(name)}/wake`, {
    method: "POST",
  });

  const data = (await res.json()) as { ok?: boolean; error?: string };

  if (!res.ok) {
    console.error(data.error || "Failed to wake mind");
    process.exit(1);
  }

  console.log(`${name} is waking up`);
}
