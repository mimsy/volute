<script lang="ts">
let {
  src,
  onClose,
}: {
  src: string;
  onClose: () => void;
} = $props();

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && !e.defaultPrevented) {
    e.preventDefault();
    onClose();
  }
}

function portal(node: HTMLElement) {
  document.body.appendChild(node);
  return {
    destroy() {
      node.remove();
    },
  };
}
</script>

<svelte:window onkeydown={handleKeydown} />

<div
  use:portal
  class="lightbox-overlay"
  role="button"
  tabindex="-1"
  onclick={onClose}
  onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") onClose(); }}
>
  <img {src} alt="" class="lightbox-image" />
</div>

<style>
  .lightbox-overlay {
    position: fixed;
    inset: 0;
    background: var(--overlay);
    z-index: var(--z-modal);
    display: flex;
    align-items: center;
    justify-content: center;
    animation: fadeIn 0.15s ease;
  }

  .lightbox-image {
    max-width: 92vw;
    max-height: 92vh;
    object-fit: contain;
    border-radius: var(--radius);
  }
</style>
