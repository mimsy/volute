<script lang="ts">
import type { Snippet } from "svelte";
import type { Mind } from "../lib/api";
import { getDisplayStatus } from "../lib/format";
import StatusBadge from "./StatusBadge.svelte";

let {
  mind,
  children,
}: {
  mind: Mind;
  children: Snippet;
} = $props();

let showCard = $state(false);
let cardX = $state(0);
let cardY = $state(0);
let hoverTimer: ReturnType<typeof setTimeout> | undefined;
let wrapperEl: HTMLSpanElement;

let hasProfile = $derived(!!mind.displayName || !!mind.description || !!mind.avatar);

function formatCreated(dateStr: string): string {
  try {
    const d = new Date(dateStr.endsWith("Z") ? dateStr : `${dateStr}Z`);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

function handleMouseEnter() {
  if (!hasProfile) return;
  hoverTimer = setTimeout(() => {
    const rect = wrapperEl.getBoundingClientRect();
    cardX = rect.left;
    cardY = rect.top - 6;
    showCard = true;
  }, 300);
}

function handleMouseLeave() {
  clearTimeout(hoverTimer);
  showCard = false;
}
</script>

<span
  class="hover-wrapper"
  bind:this={wrapperEl}
  onmouseenter={handleMouseEnter}
  onmouseleave={handleMouseLeave}
>
  {@render children()}
</span>

{#if showCard}
  <div class="hover-card" style:left="{cardX}px" style:bottom="{window.innerHeight - cardY}px">
    {#if mind.avatar}
      <img
        src={`/api/minds/${encodeURIComponent(mind.name)}/avatar`}
        alt=""
        class="avatar"
      />
    {/if}
    <div class="info">
      <span class="name-row">
        {#if mind.displayName}
          <span class="display-name">{mind.displayName}</span>
        {:else}
          <span class="display-name">{mind.name}</span>
        {/if}
        <StatusBadge status={getDisplayStatus(mind)} />
      </span>
      {#if mind.description}
        <span class="description">{mind.description}</span>
      {/if}
      <span class="meta">@{mind.name}{#if mind.created} &middot; since {formatCreated(mind.created)}{/if}</span>
    </div>
  </div>
{/if}

<style>
  .hover-wrapper {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .hover-card {
    position: fixed;
    z-index: 100;
    display: flex;
    gap: 10px;
    padding: 10px 12px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    white-space: nowrap;
    pointer-events: none;
  }

  .avatar {
    width: 64px;
    height: 64px;
    border-radius: var(--radius);
    object-fit: cover;
    flex-shrink: 0;
  }

  .info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .name-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .display-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-0);
  }

  .description {
    font-size: 11px;
    color: var(--text-1);
    white-space: normal;
    max-width: 220px;
    margin-top: 2px;
  }

  .meta {
    font-size: 10px;
    color: var(--text-2);
    margin-top: 2px;
  }
</style>
