import { getClient, urlOf } from "../lib/api-client.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { parseArgs } from "../lib/parse-args.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

export async function run(args: string[]) {
  const { flags } = parseArgs(args, {
    mind: { type: "string" },
    channel: { type: "string" },
    limit: { type: "string" },
  });

  const name = resolveMindName(flags);
  const client = getClient();

  const url = client.api.minds[":name"].history.$url({ param: { name } });
  if (flags.channel) url.searchParams.set("channel", flags.channel);
  if (flags.limit) url.searchParams.set("limit", flags.limit);

  const res = await daemonFetch(urlOf(url));

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
    sender: string | null;
    content: string;
    created_at: string;
  }[];

  // Display in chronological order (API returns newest first, so reverse)
  for (const row of rows.reverse()) {
    const time = new Date(row.created_at).toLocaleString();
    const sender = row.sender ?? "assistant";
    console.log(`[${time}] [${row.channel}] ${sender}: ${row.content}`);
  }
}
