<script lang="ts">
import type { Snippet } from "svelte";
import type { Mind } from "../lib/api";
import { mindDotColor } from "../lib/format";
import { activeMinds } from "../lib/stores.svelte";

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
      {#if mind.displayName}
        <span class="display-name">{mind.displayName}</span>
      {/if}
      <span class="name-row">
        <span
          class="status-dot"
          class:iridescent={activeMinds.has(mind.name)}
          style:background={activeMinds.has(mind.name) ? undefined : mindDotColor(mind)}
        ></span>
        @{mind.name}
      </span>
      {#if mind.description}
        <span class="description">{mind.description}</span>
      {/if}
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
    width: 32px;
    height: 32px;
    border-radius: 50%;
    object-fit: cover;
    flex-shrink: 0;
  }

  .info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .display-name {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-0);
  }

  .name-row {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--text-2);
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

  .description {
    font-size: 11px;
    color: var(--text-1);
    white-space: normal;
    max-width: 200px;
  }
</style>
