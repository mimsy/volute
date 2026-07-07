// The pure period/time helpers from TurnTimeline.svelte, unchanged.

export function parseISOWeek(weekKey: string): Date {
  // weekKey format: "2026-W12" — returns the Monday of that week (local time)
  const [yearStr, weekStr] = weekKey.split("-W");
  const year = parseInt(yearStr, 10);
  const week = parseInt(weekStr, 10);
  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = jan4.getDay() || 7;
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - dayOfWeek + 1 + (week - 1) * 7);
  return monday;
}

// Period keys are local time. Parse without Z suffix.
export function periodKeyToDate(period: string, periodKey: string): Date {
  if (period === "hour")
    return new Date(`${periodKey.slice(0, 10)}T${periodKey.slice(11, 13)}:00:00`);
  if (period === "day") return new Date(`${periodKey}T00:00:00`);
  if (period === "week") return parseISOWeek(periodKey);
  if (period === "month") return new Date(`${periodKey}-01T00:00:00`);
  return new Date(periodKey);
}

export function formatPeriodTime(period: string, periodKey: string): string {
  const now = new Date();
  const todayLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayLocal = new Date(todayLocal);
  yesterdayLocal.setDate(todayLocal.getDate() - 1);

  if (period === "hour") {
    // Period keys are local time — parse directly
    const start = periodKeyToDate("hour", periodKey);
    const end = new Date(start.getTime() + 3600000);

    const fmtTime = (d: Date) =>
      d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

    const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const isToday = startDay.getTime() === todayLocal.getTime();
    if (isToday) {
      return `${fmtTime(start)} – ${fmtTime(end)}`;
    }
    const monthDay = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `${monthDay}, ${fmtTime(start)} – ${fmtTime(end)}`;
  }

  if (period === "day") {
    // Period keys are local dates — direct comparison
    const d = periodKeyToDate("day", periodKey);
    if (d.getTime() === todayLocal.getTime()) return "Today";
    if (d.getTime() === yesterdayLocal.getTime()) return "Yesterday";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  if (period === "week") {
    const start = parseISOWeek(periodKey);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    const fmtDate = (d: Date) =>
      d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    if (start.getFullYear() !== now.getFullYear()) {
      return `${fmtDate(start)} – ${fmtDate(end)}, ${start.getFullYear()}`;
    }
    return `${fmtDate(start)} – ${fmtDate(end)}`;
  }

  if (period === "month") {
    const [year, month] = periodKey.split("-");
    const d = new Date(parseInt(year, 10), parseInt(month, 10) - 1, 1);
    return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }

  return periodKey;
}
