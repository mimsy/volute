<script lang="ts">
import { type ClockStatus, fetchClockStatus } from "../lib/client";

let { name }: { name: string } = $props();

let clock = $state<ClockStatus | null>(null);

$effect(() => {
  const mindName = name;
  fetchClockStatus(mindName)
    .then((c) => {
      clock = c;
    })
    .catch((err) => {
      console.warn("Failed to load clock status:", err);
      clock = null;
    });
});

function formatCron(cron: string): string {
  const parts = cron.split(" ");
  if (parts.length < 5) return cron;
  const [min, hour, dom, mon, dow] = parts;

  // Every N minutes
  if (min.startsWith("*/") && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    const n = +min.slice(2);
    return n === 1 ? "every minute" : `every ${n} minutes`;
  }

  // Every N hours
  if (/^\d+$/.test(min) && hour.startsWith("*/") && dom === "*" && mon === "*" && dow === "*") {
    const n = +hour.slice(2);
    return n === 1 ? `every hour at :${String(+min).padStart(2, "0")}` : `every ${n} hours`;
  }

  // Fixed minute(s), specific hour(s), with optional day-of-week
  if (/^\d+$/.test(min) && /^[\d,]+$/.test(hour) && dom === "*" && mon === "*") {
    const hours = hour.split(",").map(Number);
    const m = +min;
    const timeStr =
      hours.length === 1 ? fmtTime(hours[0], m) : hours.map((h) => fmtTime(h, m)).join(", ");

    if (dow === "*") {
      return `daily at ${timeStr}`;
    }
    const dayStr = formatDays(dow);
    return `${dayStr} at ${timeStr}`;
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

function formatUpcoming(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = d.getTime() - now.getTime();
    if (diffMs < 0) return "now";
    const mins = Math.round(diffMs / 60_000);
    if (mins < 60) return `in ${mins}m`;
    const hours = Math.floor(mins / 60);
    const rem = mins % 60;
    if (hours < 24) return rem > 0 ? `in ${hours}h ${rem}m` : `in ${hours}h`;
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function formatAction(s: {
  message?: string;
  script?: string;
  channel?: string;
  whileSleeping?: string;
}): string {
  const lines: string[] = [];
  if (s.script) lines.push(`Script: ${s.script}`);
  else if (s.message) lines.push(`Message: ${s.message}`);
  if (s.channel) lines.push(`Channel: ${s.channel}`);
  if (s.whileSleeping) lines.push(`While sleeping: ${s.whileSleeping}`);
  return lines.join("\n");
}

function formatSleepTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch {
    return iso;
  }
}

let hasContent = $derived(
  clock && (clock.schedules.length > 0 || clock.sleep?.sleeping || clock.sleepConfig?.enabled),
);
</script>

{#if clock && hasContent}
  <div class="mind-clock">
    {#if clock.sleep?.sleeping}
      <div class="clock-row sleep-row">
        <svg class="clock-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 9A6 6 0 1 1 7 3a5 5 0 0 0 6 6z"/></svg>
        <span class="clock-label">Sleeping</span>
        {#if clock.sleep.scheduledWakeAt}
          <span class="clock-detail">wake {formatUpcoming(clock.sleep.scheduledWakeAt)}</span>
        {/if}
      </div>
    {:else if clock.sleepConfig?.enabled && clock.sleepConfig.schedule}
      <div class="clock-row sleep-row">
        <svg class="clock-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 9A6 6 0 1 1 7 3a5 5 0 0 0 6 6z"/></svg>
        <span class="clock-label">Sleep</span>
        <span class="clock-detail">{formatCron(clock.sleepConfig.schedule.sleep)} &rarr; {formatCron(clock.sleepConfig.schedule.wake)}</span>
      </div>
    {/if}

    {#if clock.schedules.length > 0}
      <div class="schedule-list">
        {#each clock.schedules as s (s.id)}
          <div class="clock-row" class:disabled={!s.enabled} title={formatAction(s)}>
            <svg class="clock-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M8 4v4l3 2"/></svg>
            <span class="clock-label">{s.id}</span>
            <span class="clock-detail">
              {#if s.cron}
                {formatCron(s.cron)}
              {:else if s.fireAt}
                {formatSleepTime(s.fireAt)}
              {/if}
            </span>
          </div>
        {/each}
      </div>
    {/if}

    {#if clock.upcoming.length > 0}
      <div class="upcoming-section">
        <span class="upcoming-label">Next</span>
        {#each clock.upcoming.slice(0, 3) as u (u.id + u.at)}
          <span class="upcoming-item">
            {u.id} {formatUpcoming(u.at)}
          </span>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .mind-clock {
    border-bottom: 1px solid var(--border);
    padding: 0 16px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .clock-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-1);
  }

  .clock-row.disabled {
    opacity: 0.4;
  }

  .clock-icon {
    width: 13px;
    height: 13px;
    flex-shrink: 0;
    color: var(--text-2);
  }

  .sleep-row .clock-icon {
    color: var(--purple);
  }

  .clock-label {
    font-weight: 500;
    white-space: nowrap;
  }

  .clock-detail {
    color: var(--text-2);
    margin-left: auto;
    text-align: right;
    white-space: nowrap;
    font-size: 11px;
  }

  .schedule-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .upcoming-section {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
    font-size: 11px;
    color: var(--text-2);
    margin-top: 4px;
    padding-top: 6px;
    border-top: 1px solid var(--border);
  }

  .upcoming-label {
    font-weight: 500;
    color: var(--text-1);
  }

  .upcoming-item {
    white-space: nowrap;
  }
</style>
