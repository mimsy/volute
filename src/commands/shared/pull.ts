import { daemonFetch } from "../../lib/daemon-client.js";
import { parseArgs } from "../../lib/parse-args.js";
import { resolveMindName } from "../../lib/resolve-mind-name.js";

export async function run(args: string[]) {
  const { flags } = parseArgs(args, {
    mind: { type: "string" },
  });

  const mindName = resolveMindName(flags);

  const res = await daemonFetch(`/api/minds/${encodeURIComponent(mindName)}/shared/pull`, {
    method: "POST",
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    console.error(body.error ?? `Server responded with ${res.status}`);
    process.exit(1);
  }

  const result = (await res.json()) as { ok: boolean; message?: string };
  if (!result.ok) {
    console.error(
      result.message ??
        "Pull failed. Try: git -C shared reset --hard main (then re-apply your changes).",
    );
    process.exit(1);
  }
  console.log("Pulled latest shared changes.");
}
