// Trimmed from packages/web/src/ui/lib/format.ts.
// Fixture timestamps are authored as local-naive ISO strings ("2026-07-06T06:12:00"),
// so no UTC normalization is applied — authored clock times display as written in
// every viewer's timezone.

export function normalizeTimestamp(dateStr: string): string {
  return dateStr;
}

/** "06:12"-style clock label for the timeline gutter. */
export function formatClockTime(dateStr: string): string {
  const d = new Date(dateStr);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
