import type { SummaryRow } from "@volute/api";
import { getClient, urlOf } from "../lib/api-client.js";
import { command } from "../lib/command.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { compactTime, isCompact } from "../lib/format-cli.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

type ActivityRow = {
  id: number;
  type: string;
  mind: string;
  summary: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

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
    case "summary": {
      let range = "";
      if (row.metadata) {
        try {
          const meta = JSON.parse(row.metadata);
          if (meta.from_time && meta.to_time) {
            const from = new Date(normalizeTimestamp(meta.from_time)).toLocaleTimeString();
            const to = new Date(normalizeTimestamp(meta.to_time)).toLocaleTimeString();
            range = ` (${from}\u2013${to})`;
          }
        } catch {}
      }
      return `[${time}] [summary${range}] ${row.content ?? ""}`;
    }
    case "session_start":
      return `[${time}] [session_start] ${row.session ?? ""}`;
    default:
      return `[${time}] [${row.type}] ${row.content ?? ""}`;
  }
}

function formatRowCompact(row: HistoryRow): string {
  const time = compactTime(row.created_at);
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
    case "summary": {
      let range = "";
      if (row.metadata) {
        try {
          const meta = JSON.parse(row.metadata);
          if (meta.from_time && meta.to_time) {
            range = ` (${compactTime(meta.from_time)}\u2013${compactTime(meta.to_time)})`;
          }
        } catch {}
      }
      return `[${time}] [summary${range}] ${row.content ?? ""}`;
    }
    case "session_start":
      return `[${time}] [session_start] ${row.session ?? ""}`;
    default:
      return `[${time}] [${row.type}] ${row.content ?? ""}`;
  }
}

/** Convert a timestamp to a period key matching the summaries format. */
function periodKeyFromTimestamp(dateStr: string, period: string): string {
  const d = new Date(normalizeTimestamp(dateStr));
  switch (period) {
    case "hour":
      return d.toISOString().slice(0, 13); // YYYY-MM-DDTHH
    case "day":
      return d.toISOString().slice(0, 10); // YYYY-MM-DD
    case "week": {
      // ISO week: YYYY-Www
      const jan4 = new Date(d.getUTCFullYear(), 0, 4);
      const dayOfYear = Math.floor((d.getTime() - jan4.getTime()) / 86400000) + 4;
      const weekNum = Math.ceil(dayOfYear / 7);
      return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
    }
    case "month":
      return d.toISOString().slice(0, 7); // YYYY-MM
    default:
      return d.toISOString().slice(0, 10);
  }
}

const PERIOD_LABELS: Record<string, string> = {
  hour: "Hourly",
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
};

function getDefaultRange(period: string): string {
  const now = new Date();
  switch (period) {
    case "hour": {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().slice(0, 10);
    }
    case "day": {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - 7);
      return d.toISOString().slice(0, 10);
    }
    case "week": {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - 28);
      return d.toISOString().slice(0, 10);
    }
    case "month": {
      const d = new Date(now);
      d.setUTCMonth(d.getUTCMonth() - 6);
      return d.toISOString().slice(0, 7);
    }
    default:
      return "";
  }
}

const cmd = command({
  name: "volute mind history",
  description: "View mind activity history",
  flags: {
    mind: { type: "string", description: "Mind name" },
    channel: { type: "string", description: "Filter by channel" },
    session: { type: "string", description: "Filter by session" },
    preset: { type: "string", description: "Use a preset view" },
    limit: { type: "string", description: "Number of entries to show" },
    full: { type: "boolean", description: "Show full details" },
    period: { type: "string", description: "Time period (hour, day, week, month)" },
    from: { type: "string", description: "Start date" },
    to: { type: "string", description: "End date" },
  },
  examples: [
    "volute mind history --mind myname",
    "volute mind history --mind myname --full",
    "volute mind history --mind myname --period day",
  ],
  run: async ({ flags }) => {
    // Meta-summary mode: --period hour|day|week|month
    if (flags.period) {
      const validPeriods = ["hour", "day", "week", "month"];
      if (!validPeriods.includes(flags.period)) {
        console.error(
          `Invalid period: ${flags.period}. Must be one of: ${validPeriods.join(", ")}`,
        );
        process.exit(1);
      }

      const name = resolveMindName(flags);
      const params = new URLSearchParams();
      params.set("mind", name);
      params.set("period", flags.period);
      if (flags.from) params.set("from", flags.from);
      else params.set("from", getDefaultRange(flags.period));
      if (flags.to) params.set("to", flags.to);
      if (flags.limit) params.set("limit", flags.limit);

      // Fetch summaries and activity in parallel
      const activityParams = new URLSearchParams();
      activityParams.set("mind", name);
      if (flags.from) activityParams.set("from", flags.from);
      else activityParams.set("from", getDefaultRange(flags.period));
      if (flags.to) activityParams.set("to", flags.to);

      const [summaryRes, activityRes] = await Promise.all([
        daemonFetch(`/api/v1/history/summaries?${params}`),
        daemonFetch(`/api/v1/history/activity?${activityParams}`),
      ]);

      if (!summaryRes.ok) {
        let errorMsg = `Failed to get summaries: ${summaryRes.status}`;
        try {
          const data = (await summaryRes.json()) as { error?: string };
          if (data.error) errorMsg = data.error;
        } catch {
          // JSON body may not be present; fall through to status-code message
        }
        console.error(errorMsg);
        process.exit(1);
      }

      const rows = (await summaryRes.json()) as SummaryRow[];
      const activities: ActivityRow[] = activityRes.ok
        ? ((await activityRes.json()) as ActivityRow[])
        : [];

      // Group activity by period key
      const activityByPeriod = new Map<string, ActivityRow[]>();
      for (const act of activities) {
        const key = periodKeyFromTimestamp(act.created_at, flags.period);
        if (!activityByPeriod.has(key)) activityByPeriod.set(key, []);
        activityByPeriod.get(key)!.push(act);
      }

      // Display in chronological order (API returns newest first)
      // Collect all period keys from both summaries and activities
      const allKeys = new Set([...rows.map((r) => r.period_key), ...activityByPeriod.keys()]);
      const sortedKeys = [...allKeys].sort();

      const summaryByKey = new Map(rows.map((r) => [r.period_key, r]));
      for (const key of sortedKeys) {
        const summary = summaryByKey.get(key);
        const periodActivities = activityByPeriod.get(key);

        const label = PERIOD_LABELS[flags.period] ?? flags.period;
        console.log(`\n=== ${key} (${label}) ===`);
        if (summary?.content) console.log(summary.content);
        if (periodActivities?.length) {
          console.log("\nActivity:");
          for (const act of periodActivities) {
            const time = new Date(normalizeTimestamp(act.created_at)).toLocaleTimeString();
            console.log(`  [${time}] ${act.summary}`);
          }
        }
        console.log();
      }
      return;
    }

    const name = resolveMindName(flags);
    const client = getClient();

    const url = client.api.minds[":name"].history.$url({ param: { name } });
    if (flags.channel) url.searchParams.set("channel", flags.channel);
    if (flags.session) url.searchParams.set("session", flags.session);
    if (flags.preset) url.searchParams.set("preset", flags.preset);
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
    const compact = isCompact();
    for (const row of rows.reverse()) {
      if (compact && (row.type === "done" || row.type === "usage")) continue;
      console.log(compact ? formatRowCompact(row) : formatRow(row));
    }
  },
});

export const run = cmd.execute;
