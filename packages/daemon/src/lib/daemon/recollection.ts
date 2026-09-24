/**
 * A mind's recollection: the consolidated first-person memories a fresh session is seeded with
 * (#1124). Most distant first — the last completed week, every day since it, then today's hours —
 * stopping where the verbatim tail begins.
 *
 * This sits on the path of a mind's first reply after every cold reset, so it only reads: no AI
 * call, ever. Where a rollup doesn't exist yet it falls back one level finer, so a boundary never
 * leaves a hole — a day not yet rolled up (just after midnight) is served as its hours, and an hour
 * not yet consolidated as its raw turn summaries (`author: "record"`). Every entry is bounded, so
 * the whole response is too.
 */
import { and, eq, gte, inArray, like, lt } from "drizzle-orm";
import { getDb } from "../db.js";
import { summaries } from "../schema.js";
import {
  getPeriodKey,
  getPreviousPeriodKey,
  getUtcTimeRange,
  parseUtcDateTime,
  type TimerPeriod,
  utcDateTimeStr,
} from "../util/period-keys.js";
import { boundEntries, cut } from "./consolidation.js";

export type RecollectionEntry = {
  period: "week" | "day" | "hour";
  period_key: string;
  /** ISO 8601 */
  start: string;
  /** ISO 8601, exclusive */
  end: string;
  content: string;
  /**
   * `consolidation`: written for the mind, in its voice. `mind`: the mind's own account.
   * `record`: log text, not memory — raw turn summaries standing in for an hour not yet
   * consolidated, or a deterministic placeholder rollup.
   */
  author: "consolidation" | "mind" | "record";
};

/**
 * Per-entry caps. A consolidated week runs ~600 words and a day ~300–500, so these only bind on
 * pathological rows; an hour is 1–3 sentences, and its cap mostly bounds the raw-turn fallback on
 * a busy hour. A typical response is 5–20k chars (a week, up to six days, today's hours); the cap
 * per entry is what keeps a pathological one bounded.
 */
export const RECOLLECTION_ENTRY_MAX_CHARS: Record<RecollectionEntry["period"], number> = {
  week: 5000,
  day: 4000,
  hour: 1500,
};

type Row = { period_key: string; content: string; metadata: string | null };

function bounds(period: TimerPeriod, key: string): { start: Date; end: Date } {
  const { start, end } = getUtcTimeRange(key, period);
  return { start: parseUtcDateTime(start), end: parseUtcDateTime(end) };
}

/**
 * Who a row speaks for. A deterministic row ("Activity during 14:00: …", a digest pending its AI
 * summary) is log text, not memory in the mind's voice, so it's labeled as the record.
 */
function authorOf(metadata: string | null): RecollectionEntry["author"] {
  try {
    const meta = JSON.parse(metadata ?? "{}");
    if (meta.author === "mind") return "mind";
    return meta.deterministic === true ? "record" : "consolidation";
  } catch {
    return "consolidation";
  }
}

function entry(
  period: RecollectionEntry["period"],
  key: string,
  content: string,
  author: RecollectionEntry["author"],
): RecollectionEntry {
  const { start, end } = bounds(period, key);
  return {
    period,
    period_key: key,
    start: start.toISOString(),
    end: end.toISOString(),
    content: cut(content.trim(), RECOLLECTION_ENTRY_MAX_CHARS[period]),
    author,
  };
}

export async function getRecollection(
  mind: string,
  before: Date,
  opts: { tailStartedAt?: Date; now?: Date } = {},
): Promise<RecollectionEntry[]> {
  // Nothing after now has happened yet; nothing inside the verbatim tail should be told twice.
  const until = new Date(Math.min(before.getTime(), (opts.now ?? new Date()).getTime()));
  const cutoff = Math.min(until.getTime(), opts.tailStartedAt?.getTime() ?? Infinity);
  const fits = (period: TimerPeriod, key: string) => bounds(period, key).end.getTime() <= cutoff;

  const db = await getDb();
  const cols = {
    period_key: summaries.period_key,
    content: summaries.content,
    metadata: summaries.metadata,
  };
  const rowsFor = async (period: TimerPeriod, keys: string[]): Promise<Map<string, Row>> => {
    const rows = await db
      .select(cols)
      .from(summaries)
      .where(
        and(
          eq(summaries.mind, mind),
          eq(summaries.period, period),
          inArray(summaries.period_key, keys),
        ),
      );
    return new Map(rows.map((r) => [r.period_key, r]));
  };

  /** A day's completed hours before the cutoff: memories where they exist, else the raw record. */
  const hoursOf = async (dayKey: string): Promise<RecollectionEntry[]> => {
    const out = new Map<string, RecollectionEntry>();
    const hourRows = await db
      .select(cols)
      .from(summaries)
      .where(
        and(
          eq(summaries.mind, mind),
          eq(summaries.period, "hour"),
          like(summaries.period_key, `${dayKey}T%`),
        ),
      );
    for (const r of hourRows) {
      if (fits("hour", r.period_key)) {
        out.set(r.period_key, entry("hour", r.period_key, r.content, authorOf(r.metadata)));
      }
    }

    const turnRows = await db
      .select({ content: summaries.content, created_at: summaries.created_at })
      .from(summaries)
      .where(
        and(
          eq(summaries.mind, mind),
          eq(summaries.period, "turn"),
          gte(summaries.created_at, getUtcTimeRange(dayKey, "day").start),
          lt(summaries.created_at, utcDateTimeStr(new Date(cutoff))),
        ),
      )
      .orderBy(summaries.created_at);
    const turnsByHour = new Map<string, string[]>();
    for (const t of turnRows) {
      const key = getPeriodKey(parseUtcDateTime(t.created_at), "hour");
      if (out.has(key) || !key.startsWith(dayKey) || !fits("hour", key)) continue;
      turnsByHour.set(key, [...(turnsByHour.get(key) ?? []), t.content]);
    }
    for (const [key, texts] of turnsByHour) {
      const joined = boundEntries(texts, RECOLLECTION_ENTRY_MAX_CHARS.hour);
      out.set(key, entry("hour", key, joined, "record"));
    }
    return [...out.values()].sort((a, b) => a.period_key.localeCompare(b.period_key));
  };

  const entries: RecollectionEntry[] = [];

  const weekKey = getPreviousPeriodKey(getPeriodKey(until, "week"), "week");
  const weekRow = fits("week", weekKey)
    ? (await rowsFor("week", [weekKey])).get(weekKey)
    : undefined;
  if (weekRow) entries.push(entry("week", weekKey, weekRow.content, authorOf(weekRow.metadata)));
  const weekEnd = bounds("week", weekKey).end.getTime();

  // Every day since the week that was told, so no weekday falls between the week and today. With
  // no week to tell (not rolled up yet, or overlapping the tail), that week's days stand in for it.
  const todayKey = getPeriodKey(until, "day");
  const firstDay = new Date(weekRow ? weekEnd : bounds("week", weekKey).start.getTime());
  const dayKeys: string[] = [];
  for (const d = firstDay; dayKeys.length < 14; d.setDate(d.getDate() + 1)) {
    const key = getPeriodKey(d, "day");
    if (key >= todayKey) break;
    dayKeys.push(key);
  }
  const dayRows = dayKeys.length > 0 ? await rowsFor("day", dayKeys) : new Map<string, Row>();
  for (const key of dayKeys) {
    const row = dayRows.get(key);
    if (row && fits("day", key)) {
      entries.push(entry("day", key, row.content, authorOf(row.metadata)));
    } else {
      // Not rolled up yet (just past midnight), or overlapping the tail: its hours instead.
      entries.push(...(await hoursOf(key)));
    }
  }
  entries.push(...(await hoursOf(todayKey)));

  return entries.filter((e) => e.content);
}
