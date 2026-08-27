/**
 * Parse a DB timestamp into a Date. SQLite's datetime('now') stores UTC as
 * "YYYY-MM-DD HH:MM:SS" with no timezone marker, which new Date() would parse
 * as local time. Zone-less strings are therefore normalized to ISO-8601 UTC;
 * strings with an explicit zone (Z or ±HH:MM) pass through unchanged.
 */
export function parseDbTimestamp(ts: string): Date {
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(ts)) return new Date(ts);
  return new Date(`${ts.replace(" ", "T")}Z`);
}

/**
 * Normalize a caller-supplied date bound to the DB's zone-less UTC text format
 * ("YYYY-MM-DD HH:MM:SS"), so it compares correctly as a plain string against
 * `created_at`.
 *
 * Accepts a bare date or a full timestamp (with `T` or a space, optional trailing `Z`).
 * A bare date on the `end` side expands to 23:59:59, so `--to 2026-08-20` covers that
 * whole day instead of stopping at its first instant — a bound that silently excluded
 * the day the caller asked for is the same "plausible wrong answer" this normalizer
 * exists to prevent. Anything unparseable throws rather than being dropped.
 */
export function normalizeDbBound(raw: string | undefined, edge: "start" | "end"): string {
  if (!raw) return "";
  const value = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return edge === "start" ? `${value} 00:00:00` : `${value} 23:59:59`;
  }
  const stamp = value.replace("T", " ").replace(/Z$/, "");
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(stamp)) return `${stamp}:00`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(stamp)) return stamp;
  throw new Error(
    `Invalid ${edge === "start" ? "from" : "to"} date: ${raw}. Use YYYY-MM-DD or "YYYY-MM-DD HH:MM:SS" (UTC).`,
  );
}
