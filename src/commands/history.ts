import { daemonFetch } from "../lib/daemon-client.js";
import { parseArgs } from "../lib/parse-args.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    channel: { type: "string" },
    limit: { type: "string" },
  });

  const name = positional[0] || process.env.VOLUTE_AGENT;

  if (!name) {
    console.error("Usage: volute history [<agent>] [--channel <ch>] [--limit N]");
    process.exit(1);
  }

  const params = new URLSearchParams();
  if (flags.channel) params.set("channel", flags.channel);
  if (flags.limit) params.set("limit", flags.limit);

  const qs = params.toString();
  const path = `/api/agents/${encodeURIComponent(name)}/history${qs ? `?${qs}` : ""}`;

  const res = await daemonFetch(path);

  if (!res.ok) {
    let errorMsg = `Failed to get history: ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) errorMsg = data.error;
    } catch {}
    console.error(errorMsg);
    process.exit(1);
  }

  const rows = (await res.json()) as {
    channel: string;
    role: string;
    sender: string | null;
    content: string;
    created_at: string;
  }[];

  // Display in chronological order (API returns newest first, so reverse)
  for (const row of rows.reverse()) {
    const time = new Date(row.created_at).toLocaleString();
    const sender = row.sender ?? row.role;
    console.log(`[${time}] [${row.channel}] ${sender}: ${row.content}`);
  }
}
