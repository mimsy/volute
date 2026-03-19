<script lang="ts">
import type { Snippet } from "svelte";

let {
  onClose,
  size = "full",
  title,
  headerActions,
  children,
}: {
  onClose: () => void;
  size?: "full" | string;
  title?: string;
  headerActions?: Snippet;
  children: Snippet;
} = $props();

let isFullSize = $derived(size === "full");

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && !e.defaultPrevented) {
    e.preventDefault();
    onClose();
  }
}
</script>

<svelte:window onkeydown={handleKeydown} />

<div
  class="modal-overlay"
  role="button"
  tabindex="-1"
  onclick={onClose}
  onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") onClose(); }}
>
  <div
    class="modal"
    role="dialog"
    tabindex="-1"
    class:full={isFullSize}
    style:width={isFullSize ? undefined : size}
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
  >
    {#if title || headerActions}
      <div class="modal-header">
        <span class="title">{title ?? ""}</span>
        <div class="header-right">
          {#if headerActions}
            {@render headerActions()}
          {/if}
          <button class="close-btn" onclick={onClose}>&#x2715;</button>
        </div>
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
    font-size: 14px;
    font-weight: 600;
    color: var(--text-0);
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .close-btn {
    background: none;
    color: var(--text-2);
    font-size: 15px;
    padding: 4px 8px;
  }

  .close-btn:hover {
    color: var(--text-0);
  }

  @media (max-width: 767px) {
    .modal.full {
      width: 95vw;
      height: 85vh;
    }
  }
</style>
