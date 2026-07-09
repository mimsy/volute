// Client-side period-key helpers.
//
// Period keys are computed by the daemon in the *server's* local timezone
// (see packages/daemon/src/lib/util/period-keys.ts). A browser viewing from a
// different timezone must therefore anchor its "now" boundary math and its
// Today/Yesterday comparisons to the server's timezone, not its own — otherwise
// it asks for the wrong day's buckets and flips Today/Yesterday at the wrong
// moment. The canonical server timezone is fetched once at load; when it is
// unknown we fall back to the browser's local time (correct for same-TZ setups).

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Calendar fields of an instant, resolved in a given IANA timezone. */
export type Wall = { year: number; month: number; day: number; hour: number };

/** Resolve the wall-clock fields of `now` in `timeZone` (browser-local if unset). */
export function wallNow(timeZone: string | undefined, now: Date = new Date()): Wall {
  if (!timeZone) {
    return {
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      day: now.getDate(),
      hour: now.getHours(),
    };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0; // some engines emit "24" for midnight
  return {
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10),
    day: parseInt(get("day"), 10),
    hour,
  };
}

/** ISO week key ("YYYY-Www") of a date, using its local calendar fields. */
export function getISOWeekKey(date: Date): string {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getFullYear()}-W${pad2(weekNum)}`;
}

/** Monday (local midnight) of the given ISO week key. */
export function parseISOWeek(weekKey: string): Date {
  const [yearStr, weekStr] = weekKey.split("-W");
  const year = parseInt(yearStr, 10);
  const week = parseInt(weekStr, 10);
  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = jan4.getDay() || 7;
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - dayOfWeek + 1 + (week - 1) * 7);
  return monday;
}

/** Day key ("YYYY-MM-DD") for a wall-clock calendar date. */
export function dayKeyOf(w: Pick<Wall, "year" | "month" | "day">): string {
  return `${w.year}-${pad2(w.month)}-${pad2(w.day)}`;
}

/**
 * The set of boundary keys the timeline's initial summary load needs, anchored
 * to the server timezone's "now".
 */
export function summaryBounds(timeZone: string | undefined, now: Date = new Date()) {
  const w = wallNow(timeZone, now);
  const todayKey = dayKeyOf(w);
  // Seven days back in the server calendar. Reading only y/m/d off a
  // browser-local Date built from server calendar fields is timezone-agnostic.
  const weekAgo = new Date(w.year, w.month - 1, w.day - 7);
  return {
    todayKey,
    hourCutoff: `${todayKey}T${pad2(w.hour)}`,
    todayHourFrom: `${todayKey}T00`,
    weekCutoff: dayKeyOf({
      year: weekAgo.getFullYear(),
      month: weekAgo.getMonth() + 1,
      day: weekAgo.getDate(),
    }),
    currentMonthKey: `${w.year}-${pad2(w.month)}`,
    currentWeekKey: getISOWeekKey(new Date(w.year, w.month - 1, w.day)),
  };
}
