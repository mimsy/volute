// ── Period key helpers (server-local time) ──
//
// Period keys use the server's local time so summaries align with the
// host's day/hour boundaries. This is the single source of truth shared by
// the summarizer, the history API range filters, and the backfill script.
//
// Formats:
//   hour  → "YYYY-MM-DDTHH"   (e.g. "2026-03-22T14")
//   day   → "YYYY-MM-DD"      (e.g. "2026-03-22")
//   week  → "YYYY-Www"        ISO week (e.g. "2026-W14")
//   month → "YYYY-MM"         (e.g. "2026-03")

/** Periods that participate in timer-driven periodic summarization */
export type TimerPeriod = "hour" | "day" | "week" | "month";

const DATE_STR_RE = /^\d{4}-\d{2}-\d{2}$/;

export function getPeriodKey(date: Date, period: TimerPeriod): string {
  switch (period) {
    case "hour": {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, "0");
      const d = String(date.getDate()).padStart(2, "0");
      const h = String(date.getHours()).padStart(2, "0");
      return `${y}-${m}-${d}T${h}`;
    }
    case "day": {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, "0");
      const d = String(date.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
    case "week":
      return getISOWeekKey(date);
    case "month": {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, "0");
      return `${y}-${m}`;
    }
  }
}

export function getISOWeekKey(date: Date): string {
  // Use local date for week calculation
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

export function isoWeekToDate(weekKey: string): Date {
  const [yearStr, weekStr] = weekKey.split("-W");
  const year = parseInt(yearStr, 10);
  const week = parseInt(weekStr, 10);
  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = jan4.getDay() || 7;
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - dayOfWeek + 1 + (week - 1) * 7);
  return monday;
}

/**
 * Convert a `YYYY-MM-DD` date string to the ISO week key of the week that
 * contains it. Used by the history API to translate date-format range bounds
 * into week keys for correct comparison against week `period_key`s.
 * Returns the input unchanged if it isn't a plain date string.
 */
export function isoWeekKeyForDateStr(dateStr: string): string {
  if (!DATE_STR_RE.test(dateStr)) return dateStr;
  const [y, m, d] = dateStr.split("-").map(Number);
  return getISOWeekKey(new Date(y, m - 1, d));
}

export function getPreviousPeriodKey(key: string, period: TimerPeriod): string {
  switch (period) {
    case "hour": {
      // Derive the previous hour by subtracting one hour from the UTC instant
      // rather than mutating local fields, so DST transitions (where a local
      // hour is skipped or repeated) don't skip or duplicate a bucket.
      const d = new Date(`${key.slice(0, 10)}T${key.slice(11)}:00:00`);
      const prev = new Date(d.getTime() - 3600000);
      return getPeriodKey(prev, "hour");
    }
    case "day": {
      const d = new Date(`${key}T00:00:00`);
      d.setDate(d.getDate() - 1);
      return getPeriodKey(d, "day");
    }
    case "week": {
      const d = isoWeekToDate(key);
      d.setDate(d.getDate() - 7);
      return getPeriodKey(d, "week");
    }
    case "month": {
      const [y, m] = key.split("-").map(Number);
      const d = new Date(y, m - 2, 1);
      return getPeriodKey(d, "month");
    }
  }
}

function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Format a Date as "YYYY-MM-DD HH:MM:SS" in UTC (matching SQLite datetime('now') format) */
export function utcDateTimeStr(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

/** Parse a "YYYY-MM-DD HH:MM:SS" UTC datetime string (as stored via datetime('now')). */
export function parseUtcDateTime(s: string): Date {
  return new Date(`${s.replace(" ", "T")}Z`);
}

/**
 * UTC bounds for a period, for comparison against `created_at` columns
 * (stored as UTC via datetime('now')). Unlike getTimeRange — whose day/week/
 * month bounds are local strings for period_key comparison — every period
 * here converts the local wall-clock range to UTC. `end` is exclusive.
 */
export function getUtcTimeRange(
  periodKey: string,
  period: TimerPeriod,
): { start: string; end: string } {
  switch (period) {
    case "hour": {
      const d = new Date(`${periodKey.slice(0, 10)}T${periodKey.slice(11)}:00:00`);
      return { start: utcDateTimeStr(d), end: utcDateTimeStr(new Date(d.getTime() + 3600000)) };
    }
    case "day": {
      const d = new Date(`${periodKey}T00:00:00`);
      const dEnd = new Date(d);
      dEnd.setDate(d.getDate() + 1);
      return { start: utcDateTimeStr(d), end: utcDateTimeStr(dEnd) };
    }
    case "week": {
      const monday = isoWeekToDate(periodKey);
      const nextMonday = new Date(monday);
      nextMonday.setDate(monday.getDate() + 7);
      return { start: utcDateTimeStr(monday), end: utcDateTimeStr(nextMonday) };
    }
    case "month": {
      const [y, m] = periodKey.split("-").map(Number);
      return {
        start: utcDateTimeStr(new Date(y, m - 1, 1)),
        end: utcDateTimeStr(new Date(y, m, 1)),
      };
    }
  }
}

export function getTimeRange(
  periodKey: string,
  period: TimerPeriod,
): { start: string; end: string } {
  // Hour: convert local period key to UTC for comparison against created_at
  // (stored as UTC via datetime('now')). Other periods return local-time
  // strings for comparison against period_key columns (which are local).
  switch (period) {
    case "hour": {
      const d = new Date(`${periodKey.slice(0, 10)}T${periodKey.slice(11)}:00:00`);
      const dEnd = new Date(d.getTime() + 3600000);
      return { start: utcDateTimeStr(d), end: utcDateTimeStr(dEnd) };
    }
    case "day":
      return { start: `${periodKey} 00:00:00`, end: `${periodKey} 23:59:59` };
    case "week": {
      const monday = isoWeekToDate(periodKey);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      return {
        start: `${localDateStr(monday)} 00:00:00`,
        end: `${localDateStr(sunday)} 23:59:59`,
      };
    }
    case "month": {
      const [y, m] = periodKey.split("-").map(Number);
      const lastDay = new Date(y, m, 0).getDate();
      return {
        start: `${periodKey}-01 00:00:00`,
        end: `${periodKey}-${String(lastDay).padStart(2, "0")} 23:59:59`,
      };
    }
  }
}
