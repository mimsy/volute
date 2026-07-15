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
