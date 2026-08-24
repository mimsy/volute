/**
 * Usage aggregation over `mind_history` — what the host's Usage page reads.
 *
 * There is no usage table: every turn's usage event is already a `mind_history` row of
 * type `usage`, priced at insert time by `usage-pricing.ts` and carrying `cost_usd`,
 * `model` and `partial` in its metadata. This module is the read side of that.
 *
 * Two things this deliberately does *not* do:
 *
 * - It never invents a cost. A turn whose model couldn't be priced has `cost_usd: null`
 *   and contributes nothing to the sum; it is counted separately as an unpriced turn so
 *   every surface can present the figure as a floor rather than a total. A dollar number
 *   quietly missing an unknown share is worse than no number at all.
 * - It is not the spend budget. These are wall-clock windows (last 24h / 7d / 30d);
 *   `SpendBudget` accumulates against a cap period that starts whenever the mind's period
 *   last reset. The two answer different questions and must never be shown as the same
 *   number.
 */

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db.js";
import { mindHistory } from "../schema.js";

/** Windows the API accepts. Anything else is a 400 rather than a silent default. */
export const USAGE_WINDOWS = ["24h", "7d", "30d"] as const;
export type UsageWindow = (typeof USAGE_WINDOWS)[number];

/**
 * Read a `?window=` param, or null when it names no window we have.
 *
 * An unrecognized window is a 400 rather than a silent default: answering the last 24
 * hours to a request that said `90d` would label a different question's answer.
 */
export function readWindow(raw: string | undefined): UsageWindow | null {
  if (raw === undefined || raw === "") return "24h";
  return (USAGE_WINDOWS as readonly string[]).includes(raw) ? (raw as UsageWindow) : null;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Bucket size and count per window: 24 hourly buckets, or N daily ones. */
const WINDOW_SHAPE: Record<UsageWindow, { bucketMs: number; buckets: number }> = {
  "24h": { bucketMs: HOUR_MS, buckets: 24 },
  "7d": { bucketMs: DAY_MS, buckets: 7 },
  "30d": { bucketMs: DAY_MS, buckets: 30 },
};

/** Token counts and cost for one mind over the window. */
export type MindUsage = {
  mind: string;
  costUsd: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** cacheRead / all input-side tokens, 0..1. 0 when nothing came in. */
  cacheHitRatio: number;
  /** Turns that carry no cost — the sum above is a floor, not a total. */
  unpricedTurns: number;
  /**
   * The subset of `unpricedTurns` emitted by a template that predates cache accounting
   * (`metadata.partial`). Split out because the two need different words: a pre-upgrade
   * mind is fixed by `volute mind upgrade`, an unknown model by pricing the model.
   */
  preUpgradeTurns: number;
  /** This mind's own spend per bucket, zero-filled, oldest first. */
  series: UsageBucket[];
};

/** A mind's numbers without its identity or its series — the shape of a total. */
export type UsageTotals = Omit<MindUsage, "mind" | "series">;

export type UsageBucket = {
  /** ISO 8601 UTC instant the bucket starts at; it covers [start, start + bucketMs). */
  start: string;
  costUsd: number;
  turns: number;
  unpricedTurns: number;
};

export type UsageReport = {
  window: UsageWindow;
  /** Window bounds as ISO 8601 UTC instants; `until` is exclusive. */
  since: string;
  until: string;
  bucketMinutes: number;
  /** Every mind's totals summed — including minds no longer in the registry. */
  total: UsageTotals;
  /** Ranked by spend, descending; ties broken by name so the order is stable. */
  minds: MindUsage[];
  /** One entry per bucket, zero-filled, oldest first. */
  series: UsageBucket[];
};

/** Zone-less UTC text, the form `mind_history.created_at` is stored in. */
function dbStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function isoStamp(ms: number): string {
  return new Date(ms).toISOString();
}

/** cacheRead over everything that arrived as input. */
export function cacheHitRatio(t: {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): number {
  const inbound = t.inputTokens + t.cacheReadTokens + t.cacheCreationTokens;
  return inbound > 0 ? t.cacheReadTokens / inbound : 0;
}

/** Window bounds, aligned to bucket boundaries so the series covers exactly the totals. */
export function windowBounds(
  window: UsageWindow,
  now = Date.now(),
): { startMs: number; endMs: number; bucketMs: number; buckets: number } {
  const { bucketMs, buckets } = WINDOW_SHAPE[window];
  // End at the top of the bucket after the current one, so the newest bucket is the
  // partial one we're living in rather than a stub that always reads zero.
  const endMs = Math.floor(now / bucketMs) * bucketMs + bucketMs;
  return { startMs: endMs - buckets * bucketMs, endMs, bucketMs, buckets };
}

const COST = sql`json_extract(${mindHistory.metadata}, '$.cost_usd')`;

/** SUM over a metadata field, coalesced — an all-null SUM is NULL, not 0. */
function sumField(path: string) {
  return sql<number>`COALESCE(SUM(json_extract(${mindHistory.metadata}, ${`$.${path}`})), 0)`;
}

const AGGREGATES = {
  costUsd: sql<number>`COALESCE(SUM(${COST}), 0)`,
  turns: sql<number>`COUNT(*)`,
  inputTokens: sumField("input_tokens"),
  outputTokens: sumField("output_tokens"),
  cacheReadTokens: sumField("cache_read_input_tokens"),
  cacheCreationTokens: sumField("cache_creation_input_tokens"),
  unpricedTurns: sql<number>`COALESCE(SUM(CASE WHEN ${COST} IS NULL THEN 1 ELSE 0 END), 0)`,
  // SQLite renders JSON `true` as 1 through json_extract.
  //
  // The `IS NULL` half is what makes "a subset of unpricedTurns" a property of this query
  // rather than a promise kept in another file. It holds today because
  // `priceUsageMetadata` returns early for partial turns — but every consumer subtracts
  // these from `unpricedTurns`, so if a partial turn ever did get a price, `spendFigure`
  // would early-return on `unpricedTurns <= 0` while pre-upgrade turns existed and the
  // UI would render a negative count.
  preUpgradeTurns: sql<number>`COALESCE(SUM(CASE WHEN json_extract(${mindHistory.metadata}, '$.partial') = 1 AND ${COST} IS NULL THEN 1 ELSE 0 END), 0)`,
};

const EMPTY_TOTAL: UsageTotals = {
  costUsd: 0,
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  cacheHitRatio: 0,
  unpricedTurns: 0,
  preUpgradeTurns: 0,
};

/** Accumulate one grouped row into a running total. `cacheHitRatio` is derived at the end. */
function addInto(acc: UsageTotals, row: Omit<UsageTotals, "cacheHitRatio">): void {
  acc.costUsd += row.costUsd;
  acc.turns += row.turns;
  acc.inputTokens += row.inputTokens;
  acc.outputTokens += row.outputTokens;
  acc.cacheReadTokens += row.cacheReadTokens;
  acc.cacheCreationTokens += row.cacheCreationTokens;
  acc.unpricedTurns += row.unpricedTurns;
  acc.preUpgradeTurns += row.preUpgradeTurns;
}

/**
 * Every bucket in the window, in order, missing ones as zeros.
 *
 * A quiet hour that simply vanished from the series would draw as a shorter, busier
 * window rather than as the quiet it was.
 */
function fill(
  keys: string[],
  startMs: number,
  bucketMs: number,
  found: Map<string, UsageBucket>,
): UsageBucket[] {
  return keys.map((key, i) => {
    const hit = found.get(key);
    return {
      start: isoStamp(startMs + i * bucketMs),
      costUsd: hit?.costUsd ?? 0,
      turns: hit?.turns ?? 0,
      unpricedTurns: hit?.unpricedTurns ?? 0,
    };
  });
}

/**
 * Aggregate usage over a window, optionally for one mind.
 *
 * `mind` is an exact match on the history's mind column — a variant reports under its own
 * name, the same way it logs.
 */
export async function usageReport(opts: {
  window: UsageWindow;
  mind?: string;
  now?: number;
}): Promise<UsageReport> {
  const { window, mind } = opts;
  const { startMs, endMs, bucketMs, buckets } = windowBounds(window, opts.now);
  const db = await getDb();

  const scope = and(
    eq(mindHistory.type, "usage"),
    sql`${mindHistory.created_at} >= ${dbStamp(startMs)}`,
    sql`${mindHistory.created_at} < ${dbStamp(endMs)}`,
    mind ? eq(mindHistory.mind, mind) : undefined,
  );

  // strftime works in UTC, which is what created_at already is.
  const bucketExpr =
    bucketMs === HOUR_MS
      ? sql<string>`strftime('%Y-%m-%d %H:00:00', ${mindHistory.created_at})`
      : sql<string>`strftime('%Y-%m-%d 00:00:00', ${mindHistory.created_at})`;

  // One grouping by (mind, bucket) answers everything: the buckets tile the window
  // exactly and every in-scope row lands in one, so per-mind totals and the install-wide
  // total are sums over these rows rather than separate queries that could disagree.
  const rows = await db
    .select({ mind: mindHistory.mind, bucket: bucketExpr, ...AGGREGATES })
    .from(mindHistory)
    .where(scope)
    .groupBy(mindHistory.mind, bucketExpr);

  const bucketKeys: string[] = [];
  for (let i = 0; i < buckets; i++) bucketKeys.push(dbStamp(startMs + i * bucketMs));

  const perMind = new Map<string, { totals: UsageTotals; buckets: Map<string, UsageBucket> }>();
  for (const row of rows) {
    let entry = perMind.get(row.mind);
    if (!entry) {
      entry = { totals: { ...EMPTY_TOTAL }, buckets: new Map() };
      perMind.set(row.mind, entry);
    }
    addInto(entry.totals, row);
    entry.buckets.set(row.bucket, {
      start: row.bucket,
      costUsd: row.costUsd,
      turns: row.turns,
      unpricedTurns: row.unpricedTurns,
    });
  }

  const minds: MindUsage[] = [...perMind.entries()]
    .map(([name, entry]) => ({
      mind: name,
      ...entry.totals,
      cacheHitRatio: cacheHitRatio(entry.totals),
      series: fill(bucketKeys, startMs, bucketMs, entry.buckets),
    }))
    .sort((a, b) => b.costUsd - a.costUsd || a.mind.localeCompare(b.mind));

  const total: UsageTotals = { ...EMPTY_TOTAL };
  const combined = new Map<string, UsageBucket>();
  for (const row of rows) {
    addInto(total, row);
    const at = combined.get(row.bucket) ?? {
      start: row.bucket,
      costUsd: 0,
      turns: 0,
      unpricedTurns: 0,
    };
    at.costUsd += row.costUsd;
    at.turns += row.turns;
    at.unpricedTurns += row.unpricedTurns;
    combined.set(row.bucket, at);
  }
  total.cacheHitRatio = cacheHitRatio(total);
  const series = fill(bucketKeys, startMs, bucketMs, combined);

  return {
    window,
    since: isoStamp(startMs),
    until: isoStamp(endMs),
    bucketMinutes: bucketMs / 60_000,
    total,
    minds,
    series,
  };
}
