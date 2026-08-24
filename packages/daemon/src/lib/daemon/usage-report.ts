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
};

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
  total: Omit<MindUsage, "mind">;
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
  preUpgradeTurns: sql<number>`COALESCE(SUM(CASE WHEN json_extract(${mindHistory.metadata}, '$.partial') = 1 THEN 1 ELSE 0 END), 0)`,
};

const EMPTY_TOTAL: Omit<MindUsage, "mind"> = {
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
  const since = dbStamp(startMs);
  const until = dbStamp(endMs);
  const db = await getDb();

  const scope = and(
    eq(mindHistory.type, "usage"),
    sql`${mindHistory.created_at} >= ${since}`,
    sql`${mindHistory.created_at} < ${until}`,
    mind ? eq(mindHistory.mind, mind) : undefined,
  );

  const rows = await db
    .select({ mind: mindHistory.mind, ...AGGREGATES })
    .from(mindHistory)
    .where(scope)
    .groupBy(mindHistory.mind);

  const minds: MindUsage[] = rows
    .map((r) => ({ ...r, cacheHitRatio: cacheHitRatio(r) }))
    .sort((a, b) => b.costUsd - a.costUsd || a.mind.localeCompare(b.mind));

  const total = minds.reduce<Omit<MindUsage, "mind">>(
    (acc, m) => ({
      costUsd: acc.costUsd + m.costUsd,
      turns: acc.turns + m.turns,
      inputTokens: acc.inputTokens + m.inputTokens,
      outputTokens: acc.outputTokens + m.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + m.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens + m.cacheCreationTokens,
      cacheHitRatio: 0,
      unpricedTurns: acc.unpricedTurns + m.unpricedTurns,
      preUpgradeTurns: acc.preUpgradeTurns + m.preUpgradeTurns,
    }),
    { ...EMPTY_TOTAL },
  );
  total.cacheHitRatio = cacheHitRatio(total);

  // strftime works in UTC, which is what created_at already is.
  const bucketExpr =
    bucketMs === HOUR_MS
      ? sql<string>`strftime('%Y-%m-%d %H:00:00', ${mindHistory.created_at})`
      : sql<string>`strftime('%Y-%m-%d 00:00:00', ${mindHistory.created_at})`;

  const bucketRows = await db
    .select({
      bucket: bucketExpr,
      costUsd: AGGREGATES.costUsd,
      turns: AGGREGATES.turns,
      unpricedTurns: AGGREGATES.unpricedTurns,
    })
    .from(mindHistory)
    .where(scope)
    .groupBy(bucketExpr);

  const byBucket = new Map(bucketRows.map((r) => [r.bucket, r]));
  // Zero-fill: a quiet hour that simply vanished from the series would draw as a
  // shorter, busier window rather than as the quiet it was.
  const series: UsageBucket[] = [];
  for (let i = 0; i < buckets; i++) {
    const ms = startMs + i * bucketMs;
    const hit = byBucket.get(dbStamp(ms));
    series.push({
      start: isoStamp(ms),
      costUsd: hit?.costUsd ?? 0,
      turns: hit?.turns ?? 0,
      unpricedTurns: hit?.unpricedTurns ?? 0,
    });
  }

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
