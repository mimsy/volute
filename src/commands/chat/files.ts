import { daemonFetch } from "../../lib/daemon-client.js";
import { parseArgs } from "../../lib/parse-args.js";
import { resolveMindName } from "../../lib/resolve-mind-name.js";

export async function run(args: string[]) {
  const { flags } = parseArgs(args, {
    mind: { type: "string" },
  });

  const mind = resolveMindName(flags);

  const res = await daemonFetch(`/api/minds/${encodeURIComponent(mind)}/files/pending`);

  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    console.error(data.error ?? `Failed to list pending files: ${res.status}`);
    process.exit(1);
  }

  const pending = (await res.json()) as Array<{
    id: string;
    sender: string;
    filename: string;
    size: number;
    createdAt: string;
  }>;

  if (pending.length === 0) {
    console.log("No pending files.");
    return;
  }

  const idW = Math.max(2, ...pending.map((p) => p.id.length));
  const senderW = Math.max(6, ...pending.map((p) => p.sender.length));
  const fileW = Math.max(4, ...pending.map((p) => p.filename.length));

  console.log(`${"ID".padEnd(idW)}  ${"SENDER".padEnd(senderW)}  ${"FILE".padEnd(fileW)}  SIZE`);
  for (const p of pending) {
    console.log(
      `${p.id.padEnd(idW)}  ${p.sender.padEnd(senderW)}  ${p.filename.padEnd(fileW)}  ${formatSize(p.size)}`,
    );
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
