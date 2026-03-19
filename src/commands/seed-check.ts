import { parseArgs } from "../lib/parse-args.js";

export async function run(args: string[]) {
  const { positional } = parseArgs(args, {});
  const name = positional[0];

  if (!name) {
    console.error("Usage: volute seed check <name>");
    process.exit(1);
  }

  const { daemonFetch } = await import("../lib/daemon-client.js");
  const res = await daemonFetch(`/api/minds/${encodeURIComponent(name)}/seed-check`);

  if (!res.ok) {
    // Mind not found or other error — exit silently
    return;
  }

  const data = (await res.json()) as { output?: string };
  if (data.output) {
    console.log(data.output);
  }
}
