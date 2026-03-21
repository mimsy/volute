// Shared formatting utilities for schedule/clock display

export function formatRelativeTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = d.getTime() - now.getTime();
    const absDiff = Math.abs(diffMs);
    const mins = Math.round(absDiff / 60_000);

    if (mins < 1) return "now";
    if (mins < 60) {
      const label = `${mins}m`;
      return diffMs < 0 ? `${label} ago` : `in ${label}`;
    }
    const hours = Math.floor(mins / 60);
    const rem = mins % 60;
    if (hours < 24) {
      const label = rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
      return diffMs < 0 ? `${label} ago` : `in ${label}`;
    }
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch {
    return iso;
  }
}

export function formatCron(cron: string): string {
  const parts = cron.split(" ");
  if (parts.length < 5) return cron;
  const [min, hour, dom, mon, dow] = parts;

  if (min.startsWith("*/") && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    const n = +min.slice(2);
    return n === 1 ? "every minute" : `every ${n} minutes`;
  }
  if (/^\d+$/.test(min) && hour.startsWith("*/") && dom === "*" && mon === "*" && dow === "*") {
    const n = +hour.slice(2);
    return n === 1 ? `every hour at :${String(+min).padStart(2, "0")}` : `every ${n} hours`;
  }
  if (/^\d+$/.test(min) && /^[\d,]+$/.test(hour) && dom === "*" && mon === "*") {
    const hours = hour.split(",").map(Number);
    const m = +min;
    const timeStr =
      hours.length === 1 ? fmtTime(hours[0], m) : hours.map((h) => fmtTime(h, m)).join(", ");
    if (dow === "*") return `daily at ${timeStr}`;
    return `${formatDays(dow)} at ${timeStr}`;
  }
  return cron;
}

function fmtTime(h: number, m: number): string {
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h % 12 || 12;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, "0")}${suffix}`;
}

function formatDays(dow: string): string {
  const names = [
    "Sundays",
    "Mondays",
    "Tuesdays",
    "Wednesdays",
    "Thursdays",
    "Fridays",
    "Saturdays",
  ];
  const indices = dow.split(",").map(Number);
  if (indices.length === 1) return names[indices[0]] ?? dow;
  if (indices.length === 5 && !indices.includes(0) && !indices.includes(6)) return "weekdays";
  if (indices.length === 2 && indices.includes(0) && indices.includes(6)) return "weekends";
  return indices.map((i) => (names[i] ?? String(i)).replace(/s$/, "")).join(", ");
}
