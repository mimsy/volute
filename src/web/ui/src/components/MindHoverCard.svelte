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
        <span
          class="status-dot"
          class:iridescent={activeMinds.has(mind.name)}
          style:background={activeMinds.has(mind.name) ? undefined : mindDotColor(mind)}
        ></span>
      </span>
      {#if mind.displayName}
        <span class="handle">@{mind.name}</span>
      {/if}
      {#if mind.description}
        <span class="description">{mind.description}</span>
      {/if}
      {#if mind.created}
        <span class="created">{mind.stage === "seed" ? "Planted" : "Sprouted"} {formatCreated(mind.created)}</span>
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
    width: 48px;
    height: 48px;
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

  .handle {
    font-size: 11px;
    color: var(--text-2);
  }

  .description {
    font-size: 11px;
    color: var(--text-1);
    white-space: normal;
    max-width: 220px;
    margin-top: 2px;
  }

  .created {
    font-size: 10px;
    color: var(--text-2);
    margin-top: 2px;
  }
</style>
