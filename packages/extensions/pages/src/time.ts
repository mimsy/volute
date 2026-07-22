/**
 * Parse a DB timestamp into a Date. SQLite's datetime('now') stores UTC as
 * "YYYY-MM-DD HH:MM:SS" with no timezone marker, which new Date() would parse as
 * local time — a recurring production bug (PR #706). Zone-less strings are
 * normalized to ISO-8601 UTC; strings with an explicit zone pass through.
 *
 * Mirrors `parseDbTimestamp` in packages/daemon/src/lib/util/time.ts. Extensions
 * can't import from the daemon, so the helper is duplicated rather than the rule
 * being left to prose.
 */
export function parseDbTimestamp(ts: string): Date {
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(ts)) return new Date(ts);
  return new Date(`${ts.replace(" ", "T")}Z`);
}

/** Render a DB timestamp as a local date string. */
export function formatDate(ts: string): string {
  return parseDbTimestamp(ts).toLocaleDateString();
}

/** Render a DB timestamp as a local date+time string. */
export function formatDateTime(ts: string): string {
  return parseDbTimestamp(ts).toLocaleString();
}

/** Format a DB timestamp as an ISO-8601 UTC string, for JSON payloads. */
export function toIso(ts: string): string {
  return parseDbTimestamp(ts).toISOString();
}
