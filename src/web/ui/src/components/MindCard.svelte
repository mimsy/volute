<script lang="ts">
import type { Mind } from "@volute/api";
import StatusBadge from "./StatusBadge.svelte";

let { mind }: { mind: Mind } = $props();
</script>

<a href={`/mind/${mind.name}`} class="card">
  <div class="header">
    <span class="name">{mind.name}</span>
    {#if mind.stage === "seed"}
      <span class="seed-badge">seed</span>
    {/if}
    <StatusBadge status={mind.status} />
  </div>
  <div class="meta">
    <span>:{mind.port}</span>
    {#each mind.channels.filter(ch => ch.name !== "web" && ch.status === "connected") as ch}
      <span class="channel-badge">{ch.displayName || ch.name}</span>
    {/each}
  </div>
</a>

<style>
  .card {
    display: block;
    padding: 20px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .card:hover {
    border-color: var(--border-bright);
    background: var(--bg-3);
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }

  .name {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-0);
  }

  .seed-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    border-radius: var(--radius);
    background: rgba(251, 191, 36, 0.08);
    color: var(--yellow);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 16px;
    color: var(--text-2);
    font-size: 12px;
  }

  .channel-badge {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: var(--radius);
    background: var(--accent-dim);
    color: var(--accent);
  }
</style>
