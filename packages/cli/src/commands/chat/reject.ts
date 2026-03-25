import { daemonFetch } from "../../lib/daemon-client.js";
import { parseArgs } from "../../lib/parse-args.js";
import { resolveMindName } from "../../lib/resolve-mind-name.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    mind: { type: "string" },
  });

  const mind = resolveMindName(flags);
  const id = positional[0];

  if (!id) {
    console.error("Usage: volute chat reject <id> [--mind <name>]");
    process.exit(1);
  }

  const res = await daemonFetch(`/api/minds/${encodeURIComponent(mind)}/files/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });

  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    console.error(data.error ?? `Failed to reject file: ${res.status}`);
    process.exit(1);
  }

  console.log(`File rejected: ${id}`);
}
