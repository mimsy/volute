import { getClient, urlOf } from "../lib/api-client.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { parseArgs } from "../lib/parse-args.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

type HistoryRow = {
  type: string;
  channel: string | null;
  session: string | null;
  sender: string | null;
  content: string | null;
  metadata: string | null;
  created_at: string;
};

/** Ensure a DB timestamp (UTC without Z) is parsed correctly. */
function normalizeTimestamp(dateStr: string): string {
  return dateStr.endsWith("Z") ? dateStr : `${dateStr}Z`;
}

function formatRow(row: HistoryRow): string {
  const time = new Date(normalizeTimestamp(row.created_at)).toLocaleString();
  const channel = row.channel ?? "";

  switch (row.type) {
    case "inbound":
    case "outbound": {
      const sender = row.sender ?? (row.type === "outbound" ? "mind" : "unknown");
      return `[${time}] [${channel}] ${sender}: ${row.content ?? ""}`;
    }
    case "text":
      return `[${time}] [text] ${row.content ?? ""}`;
    case "thinking":
      return `[${time}] [thinking] ${(row.content ?? "").slice(0, 200)}${(row.content?.length ?? 0) > 200 ? "..." : ""}`;
    case "tool_use": {
      let toolName = "unknown";
      if (row.metadata) {
        try {
          const meta = JSON.parse(row.metadata);
          toolName = meta.name ?? toolName;
        } catch {}
      }
      return `[${time}] [tool] ${toolName}${row.content ? `: ${row.content.slice(0, 100)}` : ""}`;
    }
    case "tool_result":
      return `[${time}] [result] ${(row.content ?? "").slice(0, 200)}${(row.content?.length ?? 0) > 200 ? "..." : ""}`;
    case "usage": {
      if (row.metadata) {
        try {
          const meta = JSON.parse(row.metadata);
          return `[${time}] [usage] in=${meta.input_tokens ?? 0} out=${meta.output_tokens ?? 0}`;
        } catch {}
      }
      return `[${time}] [usage]`;
    }
    case "done":
      return `[${time}] [done]`;
    case "log": {
      let category = "";
      if (row.metadata) {
        try {
          const meta = JSON.parse(row.metadata);
          category = meta.category ? `${meta.category}: ` : "";
        } catch {}
      }
      return `[${time}] [log] ${category}${row.content ?? ""}`;
    }
    case "session_start":
      return `[${time}] [session_start] ${row.session ?? ""}`;
    default:
      return `[${time}] [${row.type}] ${row.content ?? ""}`;
  }
}

export async function run(args: string[]) {
  const { flags } = parseArgs(args, {
    mind: { type: "string" },
    channel: { type: "string" },
    limit: { type: "string" },
    full: { type: "boolean" },
  });

  const name = resolveMindName(flags);
  const client = getClient();

  const url = client.api.minds[":name"].history.$url({ param: { name } });
  if (flags.channel) url.searchParams.set("channel", flags.channel);
  if (flags.limit) url.searchParams.set("limit", flags.limit);
  if (flags.full) url.searchParams.set("full", "true");

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

  const rows = (await res.json()) as HistoryRow[];

  // Display in chronological order (API returns newest first, so reverse)
  for (const row of rows.reverse()) {
    console.log(formatRow(row));
  }
}
