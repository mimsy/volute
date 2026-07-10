import type { SummaryRow, TurnRow } from "@volute/api";

// Builds the chronological "today" section of the turn timeline: hour summaries
// interleaved with individual turn rows. Turns render individually when they are
// active/current-hour, or when they fall in an earlier-today hour that has NO hour
// summary yet (summarizer lag/failure). This makes a missing summary degrade to
// "more detail" instead of a silent gap.

export type TodayItem = { kind: "summary"; summary: SummaryRow } | { kind: "turn"; turn: TurnRow };

function normalizeTs(s: string): string {
  return s.endsWith("Z") ? s : `${s}Z`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local-time hour key ("YYYY-MM-DDTHH") for a date, matching summary period_keys. */
function localHourKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}`;
}

/** Completion time (ms) for a turn: to_time from summary metadata, else created_at. */
function turnCompletionMs(turn: TurnRow): number {
  const toTime = (turn.summary_meta as Record<string, unknown> | null)?.to_time as
    | string
    | undefined;
  return new Date(normalizeTs(toTime ?? turn.created_at)).getTime();
}

/** Local hour-start (ms) for an hour summary period_key. */
function hourSummaryMs(periodKey: string): number {
  return new Date(`${periodKey.slice(0, 10)}T${periodKey.slice(11, 13)}:00:00`).getTime();
}

export function buildTodayItems(opts: {
  now: Date;
  hourSummaries: SummaryRow[];
  turnsData: TurnRow[];
  isActive: (turn: TurnRow) => boolean;
}): TodayItem[] {
  const { now, hourSummaries, turnsData, isActive } = opts;

  const currentHourStart = new Date(now);
  currentHourStart.setMinutes(0, 0, 0);
  const currentHourMs = currentHourStart.getTime();

  const todayStartMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  const coveredHours = new Set(hourSummaries.map((s) => s.period_key));

  const sortable: { sort: number; item: TodayItem }[] = [];

  for (const s of hourSummaries) {
    sortable.push({ sort: hourSummaryMs(s.period_key), item: { kind: "summary", summary: s } });
  }

  for (const t of turnsData) {
    const ms = turnCompletionMs(t);
    if (isActive(t)) {
      // Active turns are live; sort into the current hour region regardless of start time.
      sortable.push({ sort: Math.max(ms, currentHourMs), item: { kind: "turn", turn: t } });
      continue;
    }
    if (ms >= currentHourMs) {
      // Current, in-progress hour — no hour summary exists yet.
      sortable.push({ sort: ms, item: { kind: "turn", turn: t } });
    } else if (ms >= todayStartMs && !coveredHours.has(localHourKey(new Date(ms)))) {
      // Earlier today, but this hour has no summary → show the turn individually.
      sortable.push({ sort: ms, item: { kind: "turn", turn: t } });
    }
    // Otherwise the turn is covered by an existing hour/day summary — omit it here.
  }

  sortable.sort((a, b) => a.sort - b.sort);
  return sortable.map((x) => x.item);
}
