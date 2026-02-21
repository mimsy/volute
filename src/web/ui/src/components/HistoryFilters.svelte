<script lang="ts">
import type { HistorySession } from "../lib/api";
import { formatRelativeTime } from "../lib/format";

export type FilterState = {
  channel: string;
  session: string;
  types: Set<string>;
  live: boolean;
};

const EVENT_TYPES = [
  { name: "inbound", color: "var(--blue)" },
  { name: "outbound", color: "var(--accent)" },
  { name: "tool_use", color: "var(--yellow)" },
  { name: "tool_result", color: "var(--yellow)" },
  { name: "thinking", color: "var(--text-2)" },
  { name: "usage", color: "var(--purple)" },
  { name: "log", color: "var(--text-2)" },
] as const;

const ALL_TYPES = new Set(EVENT_TYPES.map((t) => t.name));

let {
  channels,
  sessions,
  filters,
  onchange,
}: {
  channels: string[];
  sessions: HistorySession[];
  filters: FilterState;
  onchange: (filters: FilterState) => void;
} = $props();

function setChannel(e: Event) {
  const value = (e.target as HTMLSelectElement).value;
  onchange({ ...filters, channel: value });
}

function setSession(e: Event) {
  const value = (e.target as HTMLSelectElement).value;
  onchange({ ...filters, session: value });
}

function toggleType(typeName: string) {
  const next = new Set(filters.types);
  const allActive = next.size === ALL_TYPES.size;
  const onlyOne = next.size === 1 && next.has(typeName);

  if (allActive) {
    // Solo mode: deactivate all others
    onchange({ ...filters, types: new Set([typeName]) });
  } else if (onlyOne) {
    // Reactivate all
    onchange({ ...filters, types: new Set(ALL_TYPES) });
  } else {
    // Toggle individually
    if (next.has(typeName)) {
      next.delete(typeName);
    } else {
      next.add(typeName);
    }
    onchange({ ...filters, types: next });
  }
}

function toggleLive() {
  onchange({ ...filters, live: !filters.live });
}
</script>

<div class="filters">
  <select class="dropdown" value={filters.channel} onchange={setChannel}>
    <option value="">all channels</option>
    {#each channels as ch}
      <option value={ch}>{ch}</option>
    {/each}
  </select>

  <select class="dropdown" value={filters.session} onchange={setSession}>
    <option value="">all sessions</option>
    {#each sessions as s}
      <option value={s.session}>
        {s.session.slice(0, 8)} — {formatRelativeTime(s.started_at)}
      </option>
    {/each}
  </select>

  <div class="sep"></div>

  <div class="type-pills">
    {#each EVENT_TYPES as t}
      {@const active = filters.types.has(t.name)}
      <button
        class="pill"
        class:active
        style:--pill-color={t.color}
        onclick={() => toggleType(t.name)}
      >
        <span class="pill-dot" style:background={t.color}></span>
        {t.name}
      </button>
    {/each}
  </div>

  <div class="sep"></div>

  <button class="pill live-pill" class:active={filters.live} onclick={toggleLive}>
    <span class="live-dot" class:active={filters.live}></span>
    live
  </button>
</div>

<style>
  .filters {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    padding: 8px 0 12px;
    border-bottom: 1px solid var(--border);
  }

  .dropdown {
    background: var(--bg-2);
    color: var(--text-0);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 4px 8px;
    font-size: 12px;
    font-family: var(--mono);
  }

  .sep {
    width: 1px;
    height: 16px;
    background: var(--border);
    flex-shrink: 0;
  }

  .type-pills {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 11px;
    cursor: pointer;
    border: 1px solid var(--border);
    background: var(--bg-3);
    color: var(--text-1);
    font-family: var(--mono);
    transition: all 0.15s;
  }
  .pill.active {
    border-color: color-mix(in srgb, var(--pill-color, var(--text-2)) 25%, transparent);
    background: color-mix(in srgb, var(--pill-color, var(--text-2)) 8%, transparent);
    color: var(--text-0);
  }

  .pill-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .live-pill {
    --pill-color: var(--accent);
  }
  .live-pill.active {
    border-color: color-mix(in srgb, var(--accent) 25%, transparent);
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    color: var(--text-0);
  }

  .live-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-2);
    flex-shrink: 0;
    transition: background 0.15s;
  }
  .live-dot.active {
    background: var(--accent);
    animation: pulse 2s infinite;
  }
</style>
