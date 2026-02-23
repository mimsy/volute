import { daemonFetch } from "../lib/daemon-client.js";
import { parseArgs } from "../lib/parse-args.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

export async function run(args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case "send":
      await sendFile(args.slice(1));
      break;
    case "list":
      await listPending(args.slice(1));
      break;
    case "accept":
      await acceptFile(args.slice(1));
      break;
    case "reject":
      await rejectFile(args.slice(1));
      break;
    case "trust":
      await trustSender(args.slice(1));
      break;
    case "untrust":
      await untrustSender(args.slice(1));
      break;
    case "--help":
    case "-h":
    case undefined:
      printUsage();
      break;
    default:
      printUsage();
      process.exit(1);
  }
}

function printUsage() {
  console.log(`Usage:
  volute file send <path> <target-mind> [--mind <name>]   Send a file to another mind
  volute file list [--mind <name>]                         List pending incoming files
  volute file accept <id> [--mind <name>]                  Accept a pending file
  volute file reject <id> [--mind <name>]                  Reject a pending file
  volute file trust <sender> [--mind <name>]               Trust a sender (auto-deliver)
  volute file untrust <sender> [--mind <name>]             Remove sender trust`);
}

async function sendFile(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    mind: { type: "string" },
  });

  const mind = resolveMindName(flags);
  const filePath = positional[0];
  const targetMind = positional[1];

  if (!filePath || !targetMind) {
    console.error("Usage: volute file send <path> <target-mind> [--mind <name>]");
    process.exit(1);
  }

  const res = await daemonFetch(`/api/minds/${encodeURIComponent(mind)}/files/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetMind, filePath }),
  });

  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    console.error(data.error ?? `Failed to send file: ${res.status}`);
    process.exit(1);
  }

  const data = (await res.json()) as { status: string; id?: string; destPath?: string };
  if (data.status === "delivered") {
    console.log(`File delivered to ${targetMind}: ${data.destPath}`);
  } else {
    console.log(`File pending approval from ${targetMind} (id: ${data.id})`);
  }
}

async function listPending(args: string[]) {
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

async function acceptFile(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    mind: { type: "string" },
  });

  const mind = resolveMindName(flags);
  const id = positional[0];

  if (!id) {
    console.error("Usage: volute file accept <id> [--mind <name>]");
    process.exit(1);
  }

  const res = await daemonFetch(`/api/minds/${encodeURIComponent(mind)}/files/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });

  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    console.error(data.error ?? `Failed to accept file: ${res.status}`);
    process.exit(1);
  }

  const data = (await res.json()) as { destPath: string };
  console.log(`File accepted: ${data.destPath}`);
}

async function rejectFile(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    mind: { type: "string" },
  });

  const mind = resolveMindName(flags);
  const id = positional[0];

  if (!id) {
    console.error("Usage: volute file reject <id> [--mind <name>]");
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

async function trustSender(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    mind: { type: "string" },
  });

  const mind = resolveMindName(flags);
  const sender = positional[0];

  if (!sender) {
    console.error("Usage: volute file trust <sender> [--mind <name>]");
    process.exit(1);
  }

  const res = await daemonFetch(`/api/minds/${encodeURIComponent(mind)}/files/trust`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender }),
  });

  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    console.error(data.error ?? `Failed to trust sender: ${res.status}`);
    process.exit(1);
  }

  console.log(`Trusted sender: ${sender}`);
}

async function untrustSender(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    mind: { type: "string" },
  });

  const mind = resolveMindName(flags);
  const sender = positional[0];

  if (!sender) {
    console.error("Usage: volute file untrust <sender> [--mind <name>]");
    process.exit(1);
  }

  const res = await daemonFetch(
    `/api/minds/${encodeURIComponent(mind)}/files/trust/${encodeURIComponent(sender)}`,
    { method: "DELETE" },
  );

  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    console.error(data.error ?? `Failed to untrust sender: ${res.status}`);
    process.exit(1);
  }

  console.log(`Untrusted sender: ${sender}`);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
