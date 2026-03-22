<script lang="ts">
import type { Mind } from "@volute/api";
import StatusBadge from "../ui/StatusBadge.svelte";

let { mind }: { mind: Mind } = $props();
</script>

<a href={`/mind/${mind.name}`} class="card">
  <div class="header">
    <div class="header-left">
      {#if mind.avatar}
        <img
          src={`/api/minds/${encodeURIComponent(mind.name)}/avatar`}
          alt=""
          class="card-avatar"
        />
      {/if}
      <span class="name">{mind.displayName ?? mind.name}</span>
      {#if mind.displayName && mind.displayName !== mind.name}
        <span class="username">@{mind.name}</span>
      {/if}
    </div>
    {#if mind.stage === "seed"}
      <span class="seed-badge">seed</span>
    {/if}
    <StatusBadge status={mind.status} />
  </div>
  {#if mind.description}
    <p class="description">{mind.description}</p>
  {/if}
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

  .header-left {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .card-avatar {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    object-fit: cover;
  }

  .name {
    font-family: var(--display);
    font-size: 19px;
    font-weight: 400;
    color: var(--text-0);
  }

  .username {
    font-size: 13px;
    color: var(--text-2);
  }

  .description {
    font-size: 13px;
    color: var(--text-1);
    margin: 0 0 8px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .seed-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    border-radius: var(--radius);
    background: var(--yellow-bg);
    color: var(--yellow);
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 16px;
    color: var(--text-2);
    font-size: 13px;
  }

  .channel-badge {
    font-size: 11px;
    padding: 2px 6px;
    border-radius: var(--radius);
    background: var(--accent-dim);
    color: var(--accent);
  }
</style>
