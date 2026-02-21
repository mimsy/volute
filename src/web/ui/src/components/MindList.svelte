<script lang="ts">
import type { Mind } from "../lib/api";
import { normalizeTimestamp } from "../lib/format";
import StatusBadge from "./StatusBadge.svelte";

let {
  minds,
  selectedMind,
  onSelect,
  onSeed,
}: {
  minds: Mind[];
  selectedMind: string | null;
  onSelect: (name: string) => void;
  onSeed: () => void;
} = $props();

function getDisplayStatus(mind: Mind): string {
  if (mind.status !== "running") return mind.status;
  if (!mind.lastActiveAt) return "running";
  const ago = Date.now() - new Date(normalizeTimestamp(mind.lastActiveAt)).getTime();
  return ago < 5 * 60_000 ? "active" : "running";
}
</script>

<div class="mind-list">
  {#each minds as mind (mind.name)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="mind-item"
      class:active={mind.name === selectedMind}
      onclick={() => onSelect(mind.name)}
      onkeydown={() => {}}
    >
      <StatusBadge status={getDisplayStatus(mind)} />
      <span class="mind-name">{mind.name}</span>
      {#if mind.stage === "seed"}
        <span class="seed-tag">seed</span>
      {/if}
    </div>
  {/each}
  {#if minds.length === 0}
    <div class="empty">No minds registered</div>
  {/if}
  <button class="seed-btn" onclick={onSeed}>plant a seed</button>
</div>

<style>
  .mind-list {
    display: flex;
    flex-direction: column;
  }

  .mind-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    margin: 0 4px;
    cursor: pointer;
    border-radius: var(--radius);
    transition: background 0.1s;
  }

  .mind-item:hover {
    background: var(--bg-2);
  }

  .mind-item.active {
    background: var(--bg-3);
  }

  .mind-name {
    font-size: 12px;
    color: var(--text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mind-item.active .mind-name {
    color: var(--text-0);
  }

  .seed-tag {
    font-size: 9px;
    color: var(--yellow);
    flex-shrink: 0;
  }

  .empty {
    color: var(--text-2);
    font-size: 11px;
    padding: 8px 12px;
  }

  .seed-btn {
    margin: 4px 8px;
    padding: 5px 10px;
    background: rgba(251, 191, 36, 0.08);
    color: var(--yellow);
    border-radius: var(--radius);
    font-size: 11px;
    font-weight: 500;
    border: 1px solid rgba(251, 191, 36, 0.2);
    text-align: left;
  }
</style>
