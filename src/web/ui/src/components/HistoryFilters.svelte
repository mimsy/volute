<script lang="ts">
import type { HistorySession } from "@volute/api";
import { formatRelativeTime } from "../lib/format";

export type FilterState = {
  channel: string;
  session: string;
  types: Set<string>;
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

let open = $state(false);
let channelOpen = $state(false);
let sessionOpen = $state(false);

let hasActiveFilters = $derived(
  filters.channel !== "" || filters.session !== "" || filters.types.size !== ALL_TYPES.size,
);

function closeAll() {
  channelOpen = false;
  sessionOpen = false;
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

function selectAllTypes() {
  onchange({ ...filters, types: new Set(ALL_TYPES) });
}

function selectNoneTypes() {
  onchange({ ...filters, types: new Set() });
}

function toggleOpen() {
  open = !open;
  if (!open) closeAll();
}

function handleClickOutside(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (!target.closest(".filter-container")) {
    open = false;
    closeAll();
  }
}
</script>

<svelte:document onclick={handleClickOutside} />

<div class="filter-container">
  <button class="filter-btn" class:active={open || hasActiveFilters} onclick={toggleOpen}>
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M1.5 3h13M4 8h8M6 13h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
    {#if hasActiveFilters}
      <span class="filter-dot"></span>
    {/if}
  </button>

  {#if open}
    <div class="filter-popover">
      <div class="filter-row">
        <span class="filter-label">channel</span>
        <div class="custom-select" class:open={channelOpen}>
          <button class="select-trigger" onclick={() => { const v = !channelOpen; closeAll(); channelOpen = v; }}>
            <span class="select-value">{filters.channel || "all"}</span>
            <span class="select-arrow">▾</span>
          </button>
          {#if channelOpen}
            <div class="select-menu">
              <button class="select-option" class:selected={!filters.channel} onclick={() => selectChannel("")}>all</button>
              {#each channels as ch}
                <button class="select-option" class:selected={filters.channel === ch} onclick={() => selectChannel(ch)}>{ch}</button>
              {/each}
            </div>
          {/if}
        </div>
      </div>

      <div class="filter-row">
        <span class="filter-label">session</span>
        <div class="custom-select" class:open={sessionOpen}>
          <button class="select-trigger" onclick={() => { const v = !sessionOpen; closeAll(); sessionOpen = v; }}>
            <span class="select-value">{filters.session || "all"}</span>
            <span class="select-arrow">▾</span>
          </button>
          {#if sessionOpen}
            <div class="select-menu">
              <button class="select-option" class:selected={!filters.session} onclick={() => selectSession("")}>all</button>
              {#each sessions as s}
                <button class="select-option" class:selected={filters.session === s.session} onclick={() => selectSession(s.session)}>
                  {s.session} <span class="option-meta">{formatRelativeTime(s.started_at)}</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      </div>

      <div class="filter-row types-row">
        <span class="filter-label">types</span>
        <div class="types-grid">
          <div class="types-actions">
            <button class="types-action" onclick={selectAllTypes}>all</button>
            <button class="types-action" onclick={selectNoneTypes}>none</button>
          </div>
          {#each EVENT_TYPES as t}
            {@const active = filters.types.has(t.name)}
            <button class="type-chip" class:active onclick={() => toggleType(t.name)}>
              <span class="type-dot" style:background={active ? t.color : "var(--text-2)"}></span>
              {t.name}
            </button>
          {/each}
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .filter-container {
    position: relative;
    flex-shrink: 0;
  }

  .filter-btn {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: none;
    border: none;
    color: var(--text-2);
    cursor: pointer;
    border-radius: var(--radius);
    transition: color 0.15s, background 0.15s;
  }
  .filter-btn:hover {
    color: var(--text-1);
    background: var(--bg-3);
  }
  .filter-btn.active {
    color: var(--accent);
  }

  .filter-dot {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent);
  }

  .filter-popover {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    width: 260px;
    background: var(--bg-2);
    border: 1px solid var(--border-bright);
    border-radius: var(--radius);
    z-index: 20;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .filter-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .filter-label {
    font-size: 11px;
    color: var(--text-2);
    width: 52px;
    flex-shrink: 0;
    font-family: var(--mono);
  }

  .types-row {
    align-items: flex-start;
    padding-top: 4px;
    border-top: 1px solid var(--border);
    margin-top: 2px;
  }

  .types-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    flex: 1;
  }

  .types-actions {
    display: flex;
    gap: 4px;
    width: 100%;
    margin-bottom: 2px;
  }

  .types-action {
    font-size: 10px;
    font-family: var(--mono);
    color: var(--text-2);
    background: none;
    border: none;
    cursor: pointer;
    padding: 1px 6px;
    border-radius: var(--radius);
  }
  .types-action:hover {
    color: var(--text-1);
    background: var(--bg-3);
  }

  .type-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    font-size: 10px;
    font-family: var(--mono);
    color: var(--text-2);
    background: none;
    border: none;
    cursor: pointer;
    border-radius: var(--radius);
    transition: color 0.1s;
  }
  .type-chip:hover {
    background: var(--bg-3);
    color: var(--text-1);
  }
  .type-chip.active {
    color: var(--text-1);
  }

  .type-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    flex-shrink: 0;
    transition: background 0.15s;
  }

  .custom-select {
    position: relative;
    flex: 1;
  }

  .select-trigger {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    background: var(--bg-3);
    color: var(--text-1);
    border: none;
    border-radius: var(--radius);
    padding: 3px 6px;
    font-size: 11px;
    font-family: var(--mono);
    cursor: pointer;
    transition: color 0.15s;
  }
  .select-trigger:hover {
    color: var(--text-0);
  }

  .select-value {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
  }

  .select-arrow {
    font-size: 9px;
    color: var(--text-2);
    flex-shrink: 0;
  }

  .select-menu {
    position: absolute;
    top: calc(100% + 2px);
    left: 0;
    min-width: 100%;
    max-height: 200px;
    overflow-y: auto;
    background: var(--bg-2);
    border: 1px solid var(--border-bright);
    border-radius: var(--radius);
    z-index: 30;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  }

  .select-option {
    display: block;
    width: 100%;
    text-align: left;
    padding: 5px 8px;
    font-size: 11px;
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
    margin-left: 4px;
  }
</style>
