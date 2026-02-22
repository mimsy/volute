import { daemonFetch } from "../../lib/daemon-client.js";
import { parseArgs } from "../../lib/parse-args.js";
import { resolveMindName } from "../../lib/resolve-mind-name.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    mind: { type: "string" },
  });

  const message = positional[0];
  if (!message) {
    console.error('Usage: volute shared merge "<message>" [--mind <name>]');
    process.exit(1);
  }

  const mindName = resolveMindName(flags);

  const res = await daemonFetch(`/api/minds/${encodeURIComponent(mindName)}/shared/merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    console.error(body.error ?? `Server responded with ${res.status}`);
    process.exit(1);
  }

  const result = (await res.json()) as { ok: boolean; conflicts?: boolean; message?: string };
  if (result.conflicts) {
    console.error("Merge conflicts detected. Resolve manually in the shared repo.");
    process.exit(1);
  }
  console.log(result.message ?? "Merged successfully.");
}
