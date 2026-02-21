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
  { name: "text", color: "var(--accent)" },
  { name: "tool_use", color: "var(--yellow)" },
  { name: "tool_result", color: "var(--yellow)" },
  { name: "thinking", color: "var(--text-2)" },
  { name: "usage", color: "var(--purple)" },
  { name: "session_start", color: "var(--accent)" },
  { name: "done", color: "var(--text-2)" },
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

let channelOpen = $state(false);
let sessionOpen = $state(false);
let typesOpen = $state(false);

let typeSummary = $derived(
  filters.types.size === ALL_TYPES.size
    ? "all types"
    : filters.types.size === 0
      ? "no types"
      : filters.types.size === 1
        ? [...filters.types][0]
        : `${filters.types.size} of ${ALL_TYPES.size} types`,
);

function closeAll() {
  channelOpen = false;
  sessionOpen = false;
  typesOpen = false;
}

function selectChannel(value: string) {
  channelOpen = false;
  onchange({ ...filters, channel: value });
}

function selectSession(value: string) {
  sessionOpen = false;
  onchange({ ...filters, session: value });
}

function toggleType(typeName: string) {
  const next = new Set(filters.types);
  if (next.has(typeName)) {
    next.delete(typeName);
  } else {
    next.add(typeName);
  }
  onchange({ ...filters, types: next });
}

function selectAll() {
  onchange({ ...filters, types: new Set(ALL_TYPES) });
}

function selectNone() {
  onchange({ ...filters, types: new Set() });
}

function toggleLive() {
  onchange({ ...filters, live: !filters.live });
}

function handleClickOutside(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (!target.closest(".custom-select")) {
    closeAll();
  }
}
</script>

<svelte:document onclick={handleClickOutside} />
<svelte:window onblur={closeAll} />

<div class="filters">
  <div class="custom-select" class:open={channelOpen}>
    <button class="select-trigger" onclick={() => { const v = !channelOpen; closeAll(); channelOpen = v; }}>
      <span class="select-value">{filters.channel || "all channels"}</span>
      <span class="select-arrow">▾</span>
    </button>
    {#if channelOpen}
      <div class="select-menu">
        <button class="select-option" class:selected={!filters.channel} onclick={() => selectChannel("")}>all channels</button>
        {#each channels as ch}
          <button class="select-option" class:selected={filters.channel === ch} onclick={() => selectChannel(ch)}>{ch}</button>
        {/each}
      </div>
    {/if}
  </div>

  <div class="custom-select" class:open={sessionOpen}>
    <button class="select-trigger" onclick={() => { const v = !sessionOpen; closeAll(); sessionOpen = v; }}>
      <span class="select-value">{filters.session ? `${filters.session}` : "all sessions"}</span>
      <span class="select-arrow">▾</span>
    </button>
    {#if sessionOpen}
      <div class="select-menu">
        <button class="select-option" class:selected={!filters.session} onclick={() => selectSession("")}>all sessions</button>
        {#each sessions as s}
          <button class="select-option" class:selected={filters.session === s.session} onclick={() => selectSession(s.session)}>
            {s.session} <span class="option-meta">{formatRelativeTime(s.started_at)}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <div class="custom-select" class:open={typesOpen}>
    <button class="select-trigger" onclick={() => { const v = !typesOpen; closeAll(); typesOpen = v; }}>
      <span class="select-value">{typeSummary}</span>
      <span class="select-arrow">▾</span>
    </button>
    {#if typesOpen}
      <div class="select-menu types-menu">
        <div class="types-actions">
          <button class="types-action" onclick={selectAll}>all</button>
          <button class="types-action" onclick={selectNone}>none</button>
        </div>
        {#each EVENT_TYPES as t}
          {@const active = filters.types.has(t.name)}
          <button class="select-option type-option" class:selected={active} onclick={() => toggleType(t.name)}>
            <span class="type-dot" style:background={active ? t.color : "var(--text-2)"}></span>
            {t.name}
          </button>
        {/each}
      </div>
    {/if}
  </div>

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

  .custom-select {
    position: relative;
  }

  .select-trigger {
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--bg-2);
    color: var(--text-1);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 4px 8px 4px 10px;
    font-size: 12px;
    font-family: var(--mono);
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
    min-width: 120px;
    text-align: left;
  }
  .select-trigger:hover {
    border-color: var(--border-bright);
    color: var(--text-0);
  }
  .custom-select.open .select-trigger {
    border-color: var(--border-bright);
    color: var(--text-0);
  }

  .select-value {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .select-arrow {
    font-size: 10px;
    color: var(--text-2);
    flex-shrink: 0;
  }

  .select-menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    min-width: 100%;
    max-height: 240px;
    overflow-y: auto;
    background: var(--bg-2);
    border: 1px solid var(--border-bright);
    border-radius: var(--radius);
    z-index: 10;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  }

  .select-option {
    display: block;
    width: 100%;
    text-align: left;
    padding: 6px 10px;
    font-size: 12px;
    font-family: var(--mono);
    color: var(--text-1);
    background: none;
    border: none;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.1s, color 0.1s;
  }
  .select-option:hover {
    background: var(--bg-3);
    color: var(--text-0);
  }
  .select-option.selected {
    color: var(--accent);
  }

  .option-meta {
    color: var(--text-2);
    margin-left: 6px;
  }

  .types-menu {
    min-width: 140px;
  }

  .types-actions {
    display: flex;
    gap: 4px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--border);
  }

  .types-action {
    font-size: 10px;
    font-family: var(--mono);
    color: var(--text-2);
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: var(--radius);
  }
  .types-action:hover {
    color: var(--text-1);
    background: var(--bg-3);
  }

  .type-option {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .type-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    transition: background 0.15s;
  }

  .live-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 11px;
    cursor: pointer;
    border: 1px solid var(--border);
    background: var(--bg-3);
    color: var(--text-2);
    font-family: var(--mono);
    transition: all 0.15s;
  }
  .live-pill:hover {
    border-color: var(--border-bright);
    color: var(--text-1);
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
