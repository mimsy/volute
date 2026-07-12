<script lang="ts">
import type { SeedChecklist } from "@volute/api";

let { checklist }: { checklist: SeedChecklist } = $props();

// Avatar is only part of the sprout gate when image generation is enabled.
let items = $derived([
  { label: "SOUL.md written", done: checklist.soulWritten },
  { label: "MEMORY.md written", done: checklist.memoryWritten },
  { label: "Display name set", done: checklist.displayNameSet },
  ...(checklist.imagegenEnabled ? [{ label: "Avatar set", done: checklist.avatarSet }] : []),
]);

let doneCount = $derived(items.filter((i) => i.done).length);
let ready = $derived(doneCount === items.length);
</script>

<div class="seed-progress" class:ready>
  <div class="header">
    <span class="title">Orientation</span>
    <span class="count">{doneCount}/{items.length}</span>
  </div>
  <ul class="checklist">
    {#each items as item (item.label)}
      <li class:done={item.done}>
        <span class="mark" aria-hidden="true">{item.done ? "✓" : "○"}</span>
        <span class="label">{item.label}</span>
      </li>
    {/each}
  </ul>
  <p class="hint">
    {#if ready}
      Ready to sprout — the seed can run <code>volute seed sprout</code>.
    {:else}
      Steps the seed completes before it can sprout into a full mind.
    {/if}
  </p>
</div>

<style>
  .seed-progress {
    padding: 10px 14px;
    border-bottom: 1px solid var(--yellow-bg);
    background: var(--yellow-bg);
    flex-shrink: 0;
  }

  .seed-progress.ready {
    border-bottom-color: var(--green-bg, var(--border));
    background: var(--green-bg, var(--yellow-bg));
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .title {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--yellow);
  }

  .seed-progress.ready .title {
    color: var(--green, var(--yellow));
  }

  .count {
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: var(--text-2);
  }

  .checklist {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
  }

  .checklist li {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--text-2);
  }

  .checklist li.done {
    color: var(--text-0);
  }

  .mark {
    width: 14px;
    text-align: center;
    color: var(--text-3, var(--text-2));
  }

  .checklist li.done .mark {
    color: var(--green, var(--yellow));
  }

  .hint {
    margin: 8px 0 0;
    font-size: 12px;
    color: var(--text-2);
  }

  .hint code {
    font-size: 11px;
    background: var(--bg-2, rgba(0, 0, 0, 0.1));
    padding: 1px 4px;
    border-radius: 3px;
  }
</style>
