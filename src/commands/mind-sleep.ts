import { parseArgs } from "@volute/shared/parse-args";
import { daemonFetch } from "../lib/daemon-client.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    mind: { type: "string" },
    "wake-at": { type: "string" },
  });

  const name = positional[0] || resolveMindName(flags as { mind?: string });
  if (!name) {
    console.error("Usage: volute mind sleep <name> [--wake-at <time>]");
    process.exit(1);
  }

  const body: Record<string, string> = {};
  if (flags["wake-at"]) body.wakeAt = flags["wake-at"] as string;

  const res = await daemonFetch(`/api/minds/${encodeURIComponent(name)}/sleep`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as { ok?: boolean; error?: string };

  if (!res.ok) {
    console.error(data.error || "Failed to put mind to sleep");
    process.exit(1);
  }

  console.log(`${name} is going to sleep`);
}
