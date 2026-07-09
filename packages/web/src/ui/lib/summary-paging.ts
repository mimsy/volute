import type { SummaryRow } from "@volute/api";

export type PagingTier = "week" | "month";

/**
 * Decide which tier to page and the `to` cursor for the next backward page.
 * Going back in time, detail coarsens: page the coarsest loaded tier (month if
 * any months are loaded, else week). Returns null when there is nothing coarser
 * than the day tier loaded, i.e. no summary paging is possible.
 *
 * Callers keep each tier's rows sorted ascending by `period_key`, so index 0 is
 * the oldest loaded key — the inclusive `to` cursor for the next older page.
 */
export function nextSummaryPage(
  weeks: SummaryRow[],
  months: SummaryRow[],
): { tier: PagingTier; to: string } | null {
  if (months.length > 0) return { tier: "month", to: months[0].period_key };
  if (weeks.length > 0) return { tier: "week", to: weeks[0].period_key };
  return null;
}

/**
 * Merge a freshly-fetched older page into existing rows. The API `to` bound is
 * inclusive, so the cursor row comes back again; dedup by id drops it (and any
 * other overlap). Returns the merged, ascending-sorted list and whether the
 * terminal page was reached (no new rows → hide the "load older" button).
 */
export function mergeOlderSummaries(
  existing: SummaryRow[],
  fetched: SummaryRow[],
): { merged: SummaryRow[]; exhausted: boolean } {
  const seen = new Set(existing.map((s) => s.id));
  const additions = fetched.filter((s) => !seen.has(s.id));
  if (additions.length === 0) return { merged: existing, exhausted: true };
  const merged = [...existing, ...additions].sort((a, b) =>
    a.period_key.localeCompare(b.period_key),
  );
  return { merged, exhausted: false };
}
