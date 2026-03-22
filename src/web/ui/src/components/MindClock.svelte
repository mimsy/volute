<script lang="ts">
import { type ClockStatus, fetchClockStatus } from "../lib/client";
import { activeMinds } from "../lib/stores.svelte";
import Icon from "./Icon.svelte";

type IconKind = "heartbeat" | "dream" | "sleep" | "clock";

const PALETTE = ["var(--blue)", "var(--yellow)", "var(--red)", "var(--green)", "var(--purple)"];

const BUILTIN_COLORS: Record<string, string> = {
  heartbeat: "var(--red)",
  pulse: "var(--red)",
  dream: "var(--purple)",
  dreaming: "var(--purple)",
  sleep: "var(--blue)",
};

let { name }: { name: string } = $props();

let clock = $state<ClockStatus | null>(null);
let expanded = $state(false);

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

function scheduleIcon(id: string): IconKind {
  const lower = id.toLowerCase();
  if (lower === "heartbeat" || lower === "pulse") return "heartbeat";
  if (lower === "dream" || lower === "dreaming") return "dream";
  if (lower === "sleep") return "sleep";
  return "clock";
}

function isBuiltin(id: string): boolean {
  return id.toLowerCase() in BUILTIN_COLORS;
}

// Stable color assignment for custom schedule IDs
let colorMap = new Map<string, string>();
function scheduleColor(id: string): string {
  const lower = id.toLowerCase();
  if (BUILTIN_COLORS[lower]) return BUILTIN_COLORS[lower];
  if (!colorMap.has(lower)) {
    // Hash-based assignment for stability
    let hash = 0;
    for (let i = 0; i < lower.length; i++) hash = ((hash << 5) - hash + lower.charCodeAt(i)) | 0;
    colorMap.set(lower, PALETTE[Math.abs(hash) % PALETTE.length]);
  }
  return colorMap.get(lower)!;
}

function formatRelative(iso: string): string {
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

function formatCron(cron: string): string {
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

// Build unified schedule rows: [name] | [times] | [next]
type ScheduleRow = {
  id: string;
  icon: IconKind;
  color: string;
  times: string;
  next: string;
  disabled: boolean;
  tooltip: string;
};

let rows = $derived.by(() => {
  if (!clock) return [];
  const result: ScheduleRow[] = [];
  const upcomingMap = new Map<string, string>();
  for (const u of clock.upcoming) {
    if (!upcomingMap.has(u.id)) upcomingMap.set(u.id, u.at);
  }

  // Sleep row
  if (clock.sleep?.sleeping) {
    result.push({
      id: "sleep",
      icon: "sleep",
      color: scheduleColor("sleep"),
      times: "sleeping now",
      next: clock.sleep.scheduledWakeAt
        ? `wake ${formatRelative(clock.sleep.scheduledWakeAt)}`
        : "",
      disabled: false,
      tooltip: "",
    });
  } else if (clock.sleepConfig?.enabled && clock.sleepConfig.schedule) {
    const sc = clock.sleepConfig.schedule;
    const nextSleep = upcomingMap.get("sleep");
    result.push({
      id: "sleep",
      icon: "sleep",
      color: scheduleColor("sleep"),
      times: `${formatCron(sc.sleep)} \u2192 ${formatCron(sc.wake)}`,
      next: nextSleep ? formatRelative(nextSleep) : "",
      disabled: false,
      tooltip: "",
    });
  }

  // Regular schedules
  for (const s of clock.schedules) {
    let times = "";
    if (s.cron) times = formatCron(s.cron);
    else if (s.fireAt) times = formatSleepTime(s.fireAt);
    const nextAt = upcomingMap.get(s.id);
    result.push({
      id: s.id,
      icon: scheduleIcon(s.id),
      color: scheduleColor(s.id),
      times,
      next: nextAt ? formatRelative(nextAt) : "",
      disabled: !s.enabled,
      tooltip: formatAction(s),
    });
  }

  return result;
});

// Compact summary: current/previous state + next event
type SummaryItem = { icon: IconKind; label: string; detail: string; color: string };

let currentItem = $derived.by((): SummaryItem | null => {
  if (!clock) return null;
  if (clock.sleep?.sleeping) {
    return {
      icon: "sleep",
      label: "Sleeping",
      color: scheduleColor("sleep"),
      detail: clock.sleep.scheduledWakeAt
        ? `wake ${formatRelative(clock.sleep.scheduledWakeAt)}`
        : "now",
    };
  }
  if (activeMinds.has(name) && clock.previous?.length > 0) {
    const prev = clock.previous[0];
    const elapsed = Date.now() - new Date(prev.at).getTime();
    if (elapsed < 30 * 60_000) {
      return {
        icon: scheduleIcon(prev.id),
        label: prev.id,
        color: scheduleColor(prev.id),
        detail: "active now",
      };
    }
  }
  if (clock.previous?.length > 0) {
    const prev = clock.previous[0];
    return {
      icon: scheduleIcon(prev.id),
      label: prev.id,
      color: scheduleColor(prev.id),
      detail: formatRelative(prev.at),
    };
  }
  return null;
});

let nextItem = $derived.by((): SummaryItem | null => {
  if (!clock) return null;
  const next = clock.upcoming[0];
  if (!next) return null;
  return {
    icon: scheduleIcon(next.id),
    label: next.id,
    color: scheduleColor(next.id),
    detail: formatRelative(next.at),
  };
});

let hasContent = $derived(
  clock && (clock.schedules.length > 0 || clock.sleep?.sleeping || clock.sleepConfig?.enabled),
);
</script>

{#if clock && hasContent}
  <div class="mind-clock">
    <!-- Compact summary line -->
    <button class="clock-summary" onclick={() => expanded = !expanded}>
      <div class="summary-items">
        {#if currentItem}
          <span class="summary-item">
            <span style:color={currentItem.color}><Icon kind={currentItem.icon} class="summary-icon" /></span>
            <span class="summary-label" style:color={currentItem.color}>{currentItem.label}</span>
            <span class="summary-detail">{currentItem.detail}</span>
          </span>
        {/if}
        {#if nextItem && (!currentItem || nextItem.label !== currentItem.label)}
          {#if currentItem}
            <span class="summary-sep">&middot;</span>
          {/if}
          <span class="summary-item">
            <span style:color={nextItem.color}><Icon kind={nextItem.icon} class="summary-icon" /></span>
            <span class="summary-label" style:color={nextItem.color}>{nextItem.label}</span>
            <span class="summary-detail">{nextItem.detail}</span>
          </span>
        {/if}
        {#if !currentItem && !nextItem}
          <span class="summary-item">
            <Icon kind="clock" class="summary-icon" />
            <span class="summary-label">Schedule</span>
          </span>
        {/if}
      </div>
      <svg class="expand-chevron" class:expanded viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 6l3 3 3-3"/></svg>
    </button>

    <!-- Expanded three-column schedule table -->
    {#if expanded}
      <div class="clock-details">
        {#each rows as row (row.id)}
          <div class="clock-row" class:disabled={row.disabled} title={row.tooltip}>
            <span class="row-name">
              {#if isBuiltin(row.id)}
                <span style:color={row.color}><Icon kind={row.icon} class="clock-icon" /></span>
              {:else}
                <span class="color-dot" style:background={row.color}></span>
              {/if}
              <span class="clock-label" style:color={row.color}>{row.id}</span>
            </span>
            <span class="row-times">{row.times}</span>
            <span class="row-next">{row.next}</span>
          </div>
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
  }

  .clock-summary {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    background: none;
    border: none;
    border-radius: var(--radius);
    padding: 4px 8px;
    margin: 0 -8px;
    cursor: pointer;
    color: var(--text-1);
    font-size: 12px;
    text-align: left;
    width: calc(100% + 16px);
    transition: background 0.15s;
  }

  .clock-summary:hover {
    background: var(--bg-2);
  }

  .summary-items {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
  }

  .summary-item {
    display: flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
  }

  .summary-item :global(.summary-icon) {
    width: 12px;
    height: 12px;
    flex-shrink: 0;
  }

  .summary-label {
    font-weight: 500;
  }

  .summary-detail {
    color: var(--text-2);
    font-size: 11px;
  }

  .summary-sep {
    color: var(--text-2);
  }

  .expand-chevron {
    width: 12px;
    height: 12px;
    flex-shrink: 0;
    color: var(--text-2);
    transition: transform 0.15s, opacity 0.15s;
    opacity: 0;
  }

  .clock-summary:hover .expand-chevron {
    opacity: 1;
  }

  .expand-chevron.expanded {
    opacity: 1;
    transform: rotate(180deg);
  }

  .clock-details {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border);
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

  .row-name {
    display: flex;
    align-items: center;
    gap: 5px;
    flex: 1;
    min-width: 0;
    white-space: nowrap;
  }

  .clock-row :global(.clock-icon) {
    width: 13px;
    height: 13px;
    flex-shrink: 0;
  }

  .color-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .clock-label {
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row-times,
  .row-next {
    color: var(--text-2);
    font-size: 11px;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
    text-align: right;
  }
</style>
