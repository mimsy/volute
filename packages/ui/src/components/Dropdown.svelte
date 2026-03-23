<script lang="ts">
import type { Snippet } from "svelte";
import { onMount } from "svelte";

let {
  open = false,
  onclose,
  direction = "down",
  align = "left",
  position,
  children,
  class: className,
}: {
  open: boolean;
  onclose: () => void;
  direction?: "up" | "down";
  align?: "left" | "right";
  position?: { x: number; y: number };
  children: Snippet;
  class?: string;
} = $props();

let menuEl: HTMLDivElement | undefined = $state();

function handleClickOutside(e: MouseEvent) {
  if (menuEl && !menuEl.contains(e.target as Node)) {
    onclose();
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (open && e.key === "Escape") {
    e.preventDefault();
    onclose();
  }
}

onMount(() => {
  const raf = requestAnimationFrame(() => {
    document.addEventListener("click", handleClickOutside);
  });
  return () => {
    cancelAnimationFrame(raf);
    document.removeEventListener("click", handleClickOutside);
  };
});
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    bind:this={menuEl}
    class="dropdown {className ?? ''}"
    class:up={direction === "up"}
    class:right={align === "right"}
    class:fixed={!!position}
    style:left={position ? `${position.x}px` : undefined}
    style:top={position ? `${position.y}px` : undefined}
    onclick={(e) => e.stopPropagation()}
  >
    {@render children()}
  </div>
{/if}

<style>
  .dropdown {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    min-width: 120px;
    padding: 4px 0;
    z-index: var(--z-dropdown);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    animation: fadeIn 0.1s ease;
  }

  .dropdown.up {
    top: auto;
    bottom: calc(100% + 4px);
    box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.3);
  }

  .dropdown.right {
    left: auto;
    right: 0;
  }

  .dropdown.fixed {
    position: fixed;
    top: unset;
    bottom: unset;
    left: unset;
    right: unset;
  }
</style>
