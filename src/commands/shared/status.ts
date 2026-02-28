import { daemonFetch } from "../../lib/daemon-client.js";
import { parseArgs } from "../../lib/parse-args.js";
import { resolveMindName } from "../../lib/resolve-mind-name.js";

export async function run(args: string[]) {
  const { flags } = parseArgs(args, {
    mind: { type: "string" },
  });

  const mindName = resolveMindName(flags);

  const res = await daemonFetch(`/api/minds/${encodeURIComponent(mindName)}/shared/status`);

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    console.error(body.error ?? `Server responded with ${res.status}`);
    process.exit(1);
  }

  const output = await res.text();
  if (output.trim()) {
    console.log(output.trimEnd());
  } else {
    console.log("No pending changes.");
  }
}
