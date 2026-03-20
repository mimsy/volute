<script lang="ts">
import { type ClockStatus, fetchClockStatus } from "../lib/client";
import { activeMinds } from "../lib/stores.svelte";
import Icon from "./Icon.svelte";

type IconKind = "heartbeat" | "dream" | "sleep" | "clock";

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
  return "clock";
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

// Compact summary: current/previous state + next event
let currentItem = $derived.by(() => {
  if (!clock) return null;
  if (clock.sleep?.sleeping) {
    return {
      icon: "sleep" as IconKind,
      label: "Sleeping",
      detail: clock.sleep.scheduledWakeAt
        ? `wake ${formatRelative(clock.sleep.scheduledWakeAt)}`
        : "now",
    };
  }
  // If mind is active and we have a recent previous fire, show that
  if (activeMinds.has(name) && clock.previous?.length > 0) {
    const prev = clock.previous[0];
    const elapsed = Date.now() - new Date(prev.at).getTime();
    // Only show if the previous fire was within the last 30 minutes
    if (elapsed < 30 * 60_000) {
      return { icon: scheduleIcon(prev.id), label: prev.id, detail: "active now" };
    }
  }
  // Show most recent previous fire
  if (clock.previous?.length > 0) {
    const prev = clock.previous[0];
    return { icon: scheduleIcon(prev.id), label: prev.id, detail: formatRelative(prev.at) };
  }
  return null;
});

let nextItem = $derived.by(() => {
  if (!clock) return null;
  const next = clock.upcoming[0];
  if (!next) return null;
  return { icon: scheduleIcon(next.id), label: next.id, detail: formatRelative(next.at) };
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
            <Icon kind={currentItem.icon} class="summary-icon" />
            <span class="summary-label">{currentItem.label}</span>
            <span class="summary-detail">{currentItem.detail}</span>
          </span>
        {/if}
        {#if nextItem && (!currentItem || nextItem.label !== currentItem.label)}
          {#if currentItem}
            <span class="summary-sep">&middot;</span>
          {/if}
          <span class="summary-item">
            <Icon kind={nextItem.icon} class="summary-icon" />
            <span class="summary-label">{nextItem.label}</span>
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

    <!-- Expanded details -->
    {#if expanded}
      <div class="clock-details">
        {#if clock.sleep?.sleeping}
          <div class="clock-row sleep-row">
            <Icon kind="sleep" class="clock-icon" />
            <span class="clock-label">Sleeping</span>
            {#if clock.sleep.scheduledWakeAt}
              <span class="clock-detail">wake {formatRelative(clock.sleep.scheduledWakeAt)}</span>
            {/if}
          </div>
        {:else if clock.sleepConfig?.enabled && clock.sleepConfig.schedule}
          <div class="clock-row sleep-row">
            <Icon kind="sleep" class="clock-icon" />
            <span class="clock-label">Sleep</span>
            <span class="clock-detail">{formatCron(clock.sleepConfig.schedule.sleep)} &rarr; {formatCron(clock.sleepConfig.schedule.wake)}</span>
          </div>
        {/if}

        {#if clock.schedules.length > 0}
          {#each clock.schedules as s (s.id)}
            <div class="clock-row" class:disabled={!s.enabled} title={formatAction(s)}>
              <Icon kind={scheduleIcon(s.id)} class="clock-icon" />
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
        {/if}

        {#if clock.upcoming.length > 0}
          <div class="upcoming-section">
            <span class="upcoming-label">Next</span>
            {#each clock.upcoming.slice(0, 3) as u (u.id + u.at)}
              <span class="upcoming-item">
                {u.id} {formatRelative(u.at)}
              </span>
            {/each}
          </div>
        {/if}
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
    gap: 6px;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: var(--text-1);
    font-size: 12px;
    text-align: left;
    width: 100%;
  }

  .clock-summary:hover {
    color: var(--text-0);
  }

  .summary-items {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
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
    color: var(--text-2);
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
    transition: transform 0.15s;
  }

  .expand-chevron.expanded {
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

  .clock-row :global(.clock-icon) {
    width: 13px;
    height: 13px;
    flex-shrink: 0;
    color: var(--text-2);
  }

  .sleep-row :global(.clock-icon) {
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
