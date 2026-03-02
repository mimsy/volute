<script lang="ts">
import type { Snippet } from "svelte";
import StatusBadge from "./StatusBadge.svelte";

export type HoverProfile = {
  name: string;
  displayName?: string | null;
  description?: string | null;
  avatarUrl?: string | null;
  userType: "brain" | "mind";
  status?: string;
  created?: string;
};

let {
  profile,
  children,
}: {
  profile: HoverProfile;
  children: Snippet;
} = $props();

let showCard = $state(false);
let cardX = $state(0);
let cardY = $state(0);
let flipped = $state(false);
let hoverTimer: ReturnType<typeof setTimeout> | undefined;
let wrapperEl: HTMLSpanElement;
let cardEl = $state<HTMLDivElement | undefined>();

function formatCreated(dateStr: string): string {
  try {
    const d = new Date(dateStr.endsWith("Z") ? dateStr : `${dateStr}Z`);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

function handleMouseEnter() {
  hoverTimer = setTimeout(() => {
    const rect = wrapperEl.getBoundingClientRect();
    cardX = rect.left;
    cardY = rect.top;
    flipped = false;
    showCard = true;

    // After render, check if clipped at top and flip below if needed
    requestAnimationFrame(() => {
      if (!cardEl) return;
      const cardRect = cardEl.getBoundingClientRect();

      // Clamp left so card doesn't overflow right edge
      if (cardRect.right > window.innerWidth - 8) {
        cardX = window.innerWidth - 8 - cardRect.width;
      }

      // If clipped at top, flip below the trigger
      if (cardRect.top < 8) {
        flipped = true;
      }
    });
  }, 300);
}

function handleMouseLeave() {
  clearTimeout(hoverTimer);
  showCard = false;
}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span
  class="hover-wrapper"
  bind:this={wrapperEl}
  onmouseenter={handleMouseEnter}
  onmouseleave={handleMouseLeave}
>
  {@render children()}
</span>

{#if showCard}
  <div
    class="hover-card"
    bind:this={cardEl}
    style:left="{cardX}px"
    style:top="{cardY}px"
    style:transform={flipped ? "translateY(calc(100% + 8px))" : "translateY(-100%) translateY(-8px)"}
    style:transform-origin={flipped ? "top left" : "bottom left"}
  >
    {#if profile.avatarUrl}
      <img
        src={profile.avatarUrl}
        alt=""
        class="avatar"
      />
    {/if}
    <div class="info">
      <span class="name-row">
        <span class="display-name">{profile.displayName ?? profile.name}</span>
        {#if profile.userType === "mind" && profile.status}
          <StatusBadge status={profile.status} />
        {:else if profile.userType === "brain"}
          <span class="type-label">brain</span>
        {/if}
      </span>
      {#if profile.description}
        <span class="description">{profile.description}</span>
      {/if}
      <span class="meta">@{profile.name}{#if profile.created} &middot; since {formatCreated(profile.created)}{/if}</span>
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

  .type-label {
    font-size: 10px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-2);
    background: var(--muted-bg);
    padding: 1px 6px;
    border-radius: var(--radius);
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
