<script lang="ts">
import type { Snippet } from "svelte";

let {
  onClose,
  size = "full",
  title,
  children,
}: {
  onClose: () => void;
  size?: "full" | string;
  title?: string;
  children: Snippet;
} = $props();

let isFullSize = $derived(size === "full");

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") onClose();
}
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-overlay" onclick={onClose} onkeydown={() => {}}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="modal"
    class:full={isFullSize}
    style:width={isFullSize ? undefined : size}
    onclick={(e) => e.stopPropagation()}
    onkeydown={() => {}}
  >
    {#if title}
      <div class="modal-header">
        <span class="title">{title}</span>
        <button class="close-btn" onclick={onClose}>&#x2715;</button>
      </div>
    {/if}
    {@render children()}
  </div>
</div>

<style>
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: var(--overlay);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
    animation: fadeIn 0.15s ease;
  }

  .modal {
    max-width: 90vw;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .modal.full {
    width: 80vw;
    height: 70vh;
    max-width: 960px;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--border);
    padding: 12px 16px;
    flex-shrink: 0;
  }

  .title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-0);
  }

  .close-btn {
    background: none;
    color: var(--text-2);
    font-size: 14px;
    padding: 4px 8px;
  }

  .close-btn:hover {
    color: var(--text-0);
  }
</style>
