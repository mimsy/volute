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
let cardStyle = $state("");
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
    // Render hidden at a known CSS position to measure containing-block offset
    // (ancestors with transform/animation make position:fixed relative to them, not viewport)
    cardStyle = `left:0;top:0;visibility:hidden`;
    showCard = true;

    requestAnimationFrame(() => {
      if (!cardEl) return;
      const probe = cardEl.getBoundingClientRect();
      // Offset between CSS (0,0) and actual viewport position = containing block origin
      const ox = probe.left;
      const oy = probe.top;
      const cw = cardEl.offsetWidth;
      const ch = cardEl.offsetHeight;

      // Place above trigger: card bottom at rect.top - 8
      let top = rect.top - 8 - ch;
      let left = rect.left;

      // If clipped at top, flip below
      if (top < 8) {
        top = rect.bottom + 8;
      }

      // Clamp right edge
      if (left + cw > window.innerWidth - 8) {
        left = window.innerWidth - 8 - cw;
      }

      // Convert viewport coords to CSS coords (subtract containing-block offset)
      cardStyle = `left:${left - ox}px;top:${top - oy}px`;
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
    style={cardStyle}
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
