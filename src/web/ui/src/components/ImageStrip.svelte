<script lang="ts">
let {
  images,
  onRemove,
}: {
  images: Array<{ media_type: string; data: string; preview: string }>;
  onRemove: (index: number) => void;
} = $props();
</script>

{#if images.length > 0}
  <div class="image-strip">
    {#each images as img, i (img.preview)}
      <div class="image-preview">
        <img src={img.preview} alt="" class="preview-thumb" />
        <button class="remove-image" onclick={() => onRemove(i)}>x</button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .image-strip {
    display: flex;
    gap: 8px;
    padding: 8px 0;
    border-top: 1px solid var(--border);
    overflow-x: auto;
  }

  .image-preview {
    position: relative;
    flex-shrink: 0;
  }

  .preview-thumb {
    height: 60px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
  }

  .remove-image {
    position: absolute;
    top: -4px;
    right: -4px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--bg-3);
    color: var(--text-1);
    font-size: 11px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border);
    cursor: pointer;
    padding: 0;
  }
</style>
