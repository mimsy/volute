<script lang="ts">
import type { Mind } from "@volute/api";
import { mindDotColor } from "../lib/format";
import type { Selection } from "../lib/navigate";
import { activeMinds } from "../lib/stores.svelte";

let {
  minds,
  selection,
  onHome,
  onSelectMind,
  onSeed,
}: {
  minds: Mind[];
  selection: Selection;
  onHome: () => void;
  onSelectMind: (name: string) => void;
  onSeed: () => void;
} = $props();

let sortedMinds = $derived(
  [...minds].sort((a, b) => {
    const aActive = activeMinds.has(a.name) ? 0 : a.status === "running" ? 1 : 2;
    const bActive = activeMinds.has(b.name) ? 0 : b.status === "running" ? 1 : 2;
    if (aActive !== bActive) return aActive - bActive;
    return a.name.localeCompare(b.name);
  }),
);

let activeMindName = $derived.by(() => {
  if (selection.tab !== "system") return null;
  if (selection.kind === "mind") return selection.name;
  return null;
});
</script>

<div class="sidebar-inner">
  <div class="sections">
    <!-- System -->
    <div class="section">
      <button
        class="section-toggle"
        class:active={selection.tab === "system" && selection.kind !== "mind"}
        onclick={onHome}
      >
        <span>System</span>
      </button>
    </div>

    <!-- Minds -->
    <div class="section">
      <div class="section-header-row">
        <span class="section-label">Minds</span>
        <button class="section-add" onclick={onSeed} title="Plant a seed">+</button>
      </div>
      <div class="mind-list">
        {#each sortedMinds as mind}
          <button
            class="mind-item"
            class:active={activeMindName === mind.name}
            onclick={() => onSelectMind(mind.name)}
          >
            <span
              class="status-dot"
              class:iridescent={activeMinds.has(mind.name)}
              style:background={activeMinds.has(mind.name) ? undefined : mindDotColor(mind)}
            ></span>
            <span class="mind-item-name">{mind.displayName ?? mind.name}</span>
          </button>
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
  .sidebar-inner {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .sections {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding-top: 4px;
  }

  .section {
    margin-bottom: 2px;
  }

  .section-header-row {
    display: flex;
    align-items: center;
    padding: 6px 12px;
    padding-right: 8px;
  }

  .section-label {
    flex: 1;
    color: var(--text-2);
    font-family: var(--display);
    font-size: 16px;
    font-weight: 300;
    letter-spacing: 0.02em;
  }

  .section-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    padding: 6px 12px;
    background: none;
    color: var(--text-2);
    font-family: var(--display);
    font-size: 16px;
    font-weight: 300;
    letter-spacing: 0.02em;
    text-align: left;
    border-radius: var(--radius);
    margin: 0 4px;
  }

  .section-toggle:hover {
    color: var(--text-1);
  }

  .section-toggle.active {
    color: var(--text-0);
    background: var(--bg-2);
  }

  .section-add {
    background: none;
    color: var(--text-2);
    font-size: 15px;
    padding: 2px 6px;
    border-radius: var(--radius);
    flex-shrink: 0;
  }

  .section-add:hover {
    color: var(--text-0);
    background: var(--bg-2);
  }

  .mind-list {
    display: flex;
    flex-direction: column;
  }

  .mind-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 12px 6px 26px;
    font-size: 14px;
    color: var(--text-1);
    transition: background 0.1s;
    cursor: pointer;
    background: none;
    text-align: left;
    margin: 0 4px;
    border-radius: var(--radius);
  }

  .mind-item:hover {
    background: var(--bg-2);
  }

  .mind-item.active {
    background: var(--bg-2);
    color: var(--text-0);
  }

  .mind-item-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }

  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .status-dot.iridescent {
    animation: iridescent 3s ease-in-out infinite;
  }

  @keyframes iridescent {
    0%   { background: #4ade80; }
    16%  { background: #60a5fa; }
    33%  { background: #c084fc; }
    50%  { background: #f472b6; }
    66%  { background: #fbbf24; }
    83%  { background: #34d399; }
    100% { background: #4ade80; }
  }

  @media (max-width: 767px) {
    .mind-item {
      padding: 10px 12px 10px 26px;
    }

    .section-toggle {
      padding: 8px 12px;
    }

    .status-dot {
      width: 8px;
      height: 8px;
    }
  }
</style>
