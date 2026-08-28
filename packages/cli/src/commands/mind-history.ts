import type { SummaryRow } from "@volute/api";
import { getClient, urlOf } from "../lib/api-client.js";
import { assertRange } from "../lib/assert-range.js";
import { command } from "../lib/command.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { compactDateTime, formatSender, isCompact } from "../lib/format-cli.js";
import { readStdin } from "../lib/read-stdin.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

type ActivityRow = {
  id: number;
  type: string;
  mind: string;
  summary: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export type HistoryRow = {
  type: string;
  channel: string | null;
  thread: string | null;
  sender: string | null;
  sender_display_name: string | null;
  content: string | null;
  metadata: string | null;
  turn_id: string | null;
  created_at: string;
};

/** Ensure a DB timestamp (UTC without Z) is parsed correctly. */
function normalizeTimestamp(dateStr: string): string {
  return dateStr.endsWith("Z") ? dateStr : `${dateStr}Z`;
}

/**
 * A system event's worded label, stored on the row by the daemon. Falls back to the type
 * segment of the `event:<type>:<id>` channel for rows written before the label was stored.
 */
function eventLabel(row: HistoryRow): string {
  if (row.metadata) {
    try {
      const meta = JSON.parse(row.metadata);
      if (typeof meta.label === "string" && meta.label) return meta.label;
    } catch {}
  }
  return row.channel?.split(":")[1] || "event";
}

function formatRow(row: HistoryRow, showTurn = false): string {
  const time = new Date(normalizeTimestamp(row.created_at)).toLocaleString();
  const channel = row.channel ?? "";

  switch (row.type) {
    case "inbound":
    case "outbound": {
      const sender = formatSender(
        row.sender ?? (row.type === "outbound" ? "mind" : "unknown"),
        row.sender_display_name,
      );
      return `[${time}] [${channel}] ${sender}: ${row.content ?? ""}`;
    }
    // A system event has no sender and no channel to reply to — never render it in the
    // `[channel] sender: content` message shape.
    case "event":
      return `[${time}] [event: ${eventLabel(row)}] ${row.content ?? ""}`;
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
      const turn = showTurn && row.turn_id ? ` (turn ${row.turn_id})` : "";
      return `[${time}] [summary${range}]${turn} ${row.content ?? ""}`;
    }
    case "session_start":
      return `[${time}] [session_start] ${row.thread ?? ""}`;
    default:
      return `[${time}] [${row.type}] ${row.content ?? ""}`;
  }
}

export function formatRowCompact(row: HistoryRow, showTurn = false): string {
  // Compact output is terse, but never date-less. Compact mode is always on for a mind,
  // so a multi-day window read as one afternoon and minds reasoned from it (#876, the
  // remaining call site after #869). A line quoted out of here into memory or a page
  // has to carry its own day.
  const time = compactDateTime(row.created_at);
  const channel = row.channel ?? "";

  switch (row.type) {
    case "inbound":
    case "outbound": {
      // Compact (mind-facing) output stays terse; display names are for humans.
      const sender = row.sender ?? (row.type === "outbound" ? "mind" : "unknown");
      return `[${time}] [${channel}] ${sender}: ${row.content ?? ""}`;
    }
    // A system event has no sender and no channel to reply to — never render it in the
    // `[channel] sender: content` message shape.
    case "event":
      return `[${time}] [event: ${eventLabel(row)}] ${row.content ?? ""}`;
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
            range = ` (${compactDateTime(meta.from_time)}\u2013${compactDateTime(meta.to_time)})`;
          }
        } catch {}
      }
      const turn = showTurn && row.turn_id ? ` (turn ${row.turn_id})` : "";
      return `[${time}] [summary${range}]${turn} ${row.content ?? ""}`;
    }
    case "session_start":
      return `[${time}] [session_start] ${row.thread ?? ""}`;
    default:
      return `[${time}] [${row.type}] ${row.content ?? ""}`;
  }
}

/**
 * Convert a timestamp to a period key matching the summarizer's format.
 * Uses local time to match getPeriodKey() in the daemon summarizer.
 */
function periodKeyFromTimestamp(dateStr: string, period: string): string {
  const d = new Date(normalizeTimestamp(dateStr));
  switch (period) {
    case "hour": {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      const h = String(d.getHours()).padStart(2, "0");
      return `${y}-${m}-${day}T${h}`;
    }
    case "day": {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    }
    case "week": {
      // ISO week calculation — matches daemon summarizer's getISOWeekKey()
      const local = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      local.setDate(local.getDate() + 4 - (local.getDay() || 7));
      const yearStart = new Date(local.getFullYear(), 0, 1);
      const weekNum = Math.ceil(((local.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
      return `${local.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
    }
    case "month": {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      return `${y}-${m}`;
    }
    default: {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    }
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

/**
 * Build the query for the default (non-`--period`) history request.
 *
 * `from`/`to` are forwarded, not dropped: they were accepted by the flag parser and sent
 * nowhere outside `--period` mode, so a request for one day came back as the mind's whole
 * history and looked like an answered question (bardo triage, the #907 class).
 *
 * The bounds are matched against the DB's UTC timestamps, while rows print in local time
 * — so a one-day UTC window can span two printed dates. Stated in the flag descriptions
 * rather than quietly reconciled, because guessing which the caller meant is how the
 * wrong window gets served with a straight face.
 */
export function applyHistoryQuery(
  params: URLSearchParams,
  flags: {
    channel?: string;
    thread?: string;
    preset?: string;
    limit?: number;
    from?: string;
    to?: string;
    full?: boolean;
    provisional?: boolean;
  },
): void {
  if (flags.channel) params.set("channel", flags.channel);
  if (flags.thread) params.set("session", flags.thread);
  if (flags.preset) params.set("preset", flags.preset);
  if (flags.limit !== undefined) params.set("limit", String(flags.limit));
  if (flags.from) params.set("from", flags.from);
  if (flags.to) params.set("to", flags.to);
  if (flags.full) params.set("full", "true");
  if (flags.provisional) params.set("provisional", "true");
}

/**
 * Build the two queries `--period` mode sends: summaries and activity.
 *
 * They are interleaved into one listing under shared period headers, so both must carry
 * the same window *and* the same `--limit`. `--limit` used to reach only the summaries
 * request, leaving activity at that route's own default of 100 — so `--period day --limit
 * 200` printed up to 200 summaries with activity silently truncated, exit 0, nothing
 * naming the cut, while the flag advertised a max of 200.
 */
export function buildPeriodQueries(
  name: string,
  flags: { period?: string; from?: string; to?: string; limit?: number },
): { summary: URLSearchParams; activity: URLSearchParams } {
  const from = flags.from || getDefaultRange(flags.period ?? "");
  const summary = new URLSearchParams();
  const activity = new URLSearchParams();
  for (const p of [summary, activity]) {
    p.set("mind", name);
    if (from) p.set("from", from);
    if (flags.to) p.set("to", flags.to);
    if (flags.limit !== undefined) p.set("limit", String(flags.limit));
  }
  // Only the summaries route buckets by period; activity is filtered by window alone.
  if (flags.period) summary.set("period", flags.period);
  return { summary, activity };
}

/**
 * Refuse a `--limit` the server would silently reduce.
 *
 * Both routes this command reaches cap a page at 200: the default read
 * (`GET /api/v1/minds/:name/history`) and the `--period` read
 * (`GET /api/v1/history/summaries`). `--limit` used to be a *string* flag, so the number
 * validation in `parse-args.ts` never applied and the raw text went to the server as a
 * query param, where `parseInt` finished the job in silence: `--limit 1e9` served one row,
 * `--limit notanumber` served the default fifty, `--limit -5` served one — every one of
 * them exiting 0 with real history on screen.
 *
 * That is worse than a papercut because it leaves no artifact. Every guard a careful mind
 * builds fires on a reading being *wrong*, and these readings are correct — just answers
 * to a question nobody asked. Three minds on bardo cross-checked each other into the same
 * false picture inside an hour precisely *because* they checked each other, and the
 * command lied identically to each of them. Verification is a vector. A mind that cannot
 * trust its instruments cannot trust its own memory.
 */
export function assertHistoryLimit(limit: number | undefined): void {
  assertRange("--limit", limit, 1, 200);
}

const cmd = command({
  name: "volute mind history",
  description: "View mind activity history",
  flags: {
    mind: { type: "string", description: "Mind name" },
    channel: { type: "string", description: "Filter by channel" },
    thread: { type: "string", description: "Filter by thread" },
    preset: { type: "string", description: "Use a preset view" },
    limit: { type: "number", description: "Number of entries to show (default 50, max 200)" },
    full: { type: "boolean", description: "Show full details" },
    provisional: {
      type: "boolean",
      description: "Only turn summaries you haven't rewritten yet (shows turn ids)",
    },
    period: { type: "string", description: "Time period (hour, day, week, month)" },
    from: {
      type: "string",
      description: "Start of the window, YYYY-MM-DD or 'YYYY-MM-DD HH:MM:SS' (matched in UTC)",
    },
    to: {
      type: "string",
      description: "End of the window, inclusive of the whole day for a bare date (matched in UTC)",
    },
    write: {
      type: "boolean",
      description: "Replace a turn's provisional summary with your own account (needs --turn)",
    },
    turn: { type: "string", description: "Turn id to write a summary for (with --write)" },
    text: { type: "string", description: "Summary text for --write (or pipe it via stdin)" },
  },
  examples: [
    "volute mind history --mind myname",
    "volute mind history --mind myname --full",
    "volute mind history --mind myname --period day",
    "volute mind history --mind myname --from 2026-08-20 --to 2026-08-21",
    "volute mind history --mind myname --provisional",
    'volute mind history --mind myname --write --turn <id> --text "I traced the bug and fixed it."',
  ],
  run: async ({ flags }) => {
    // Write mode: replace a turn's provisional summary with the mind's own account.
    if (flags.write) {
      // --write is a distinct mode; it takes only --turn and --text (or stdin).
      const readFlags = [
        ["--channel", flags.channel],
        ["--thread", flags.thread],
        ["--preset", flags.preset],
        ["--limit", flags.limit],
        ["--from", flags.from],
        ["--to", flags.to],
        ["--period", flags.period],
        ["--full", flags.full],
        ["--provisional", flags.provisional],
      ].filter(([, v]) => v !== undefined && v !== false);
      if (readFlags.length > 0) {
        console.error(
          `--write can't be combined with read flags (${readFlags.map(([n]) => n).join(", ")}); it takes only --turn and --text.`,
        );
        process.exit(1);
      }

      const name = resolveMindName(flags);
      const turnId = flags.turn;
      if (!turnId) {
        console.error("--write requires --turn <id> (see 'volute mind history --provisional')");
        process.exit(1);
      }
      const text = flags.text ?? (await readStdin());
      if (!text) {
        console.error("Provide --text or pipe the summary via stdin");
        process.exit(1);
      }

      const client = getClient();
      const url = client.api.v1.minds[":name"]["turn-summaries"].$url({ param: { name } });
      const res = await daemonFetch(urlOf(url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summaries: [{ turnId, content: text }] }),
      });
      if (!res.ok) {
        let msg = `Failed to save summary: ${res.status}`;
        try {
          const data = (await res.json()) as { error?: string };
          if (data.error) msg = data.error;
        } catch {}
        console.error(msg);
        process.exit(1);
      }
      console.log(`Saved your summary for turn ${turnId.slice(0, 8)}.`);
      return;
    }

    // --turn / --text only make sense in write mode; ignoring them silently would hide a mistake.
    if (flags.turn || flags.text) {
      console.error("--turn and --text only apply with --write");
      process.exit(1);
    }

    // Applies to both read modes below: the default history route and the `--period`
    // summaries route both cap a page at 200.
    assertHistoryLimit(flags.limit);

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
      const { summary: params, activity: activityParams } = buildPeriodQueries(name, flags);

      // Fetch summaries and activity in parallel
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
      let activities: ActivityRow[] = [];
      if (activityRes.ok) {
        activities = (await activityRes.json()) as ActivityRow[];
      } else {
        console.error(
          `Warning: could not fetch activity data (${activityRes.status}), showing summaries only`,
        );
      }

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

    const url = client.api.v1.minds[":name"].history.$url({ param: { name } });
    applyHistoryQuery(url.searchParams, flags);

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
    const showTurn = !!flags.provisional;
    for (const row of rows.reverse()) {
      if (compact && (row.type === "done" || row.type === "usage")) continue;
      console.log(compact ? formatRowCompact(row, showTurn) : formatRow(row, showTurn));
    }
  },
});

export const run = cmd.execute;
