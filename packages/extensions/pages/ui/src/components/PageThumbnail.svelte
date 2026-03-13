<script lang="ts">
let {
  url,
  label,
  sublabel,
  onclick,
}: {
  url: string;
  label: string;
  sublabel?: string;
  onclick?: () => void;
} = $props();

let loaded = $state(false);
</script>

<button class="thumbnail-card" {onclick}>
  <div class="thumbnail-frame">
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <iframe src={url} loading="lazy" sandbox="allow-same-origin" tabindex={-1} title={label} class:loaded onload={() => loaded = true}></iframe>
  </div>
  <div class="thumbnail-label">{label}</div>
  {#if sublabel}<div class="thumbnail-sublabel">{sublabel}</div>{/if}
</button>

<style>
  .thumbnail-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: none;
    cursor: pointer;
    text-align: left;
    color: inherit;
    padding: 0;
  }

  .thumbnail-frame {
    width: 280px;
    height: 180px;
    overflow: hidden;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--bg-0);
    transition: border-color 0.15s;
  }

  .thumbnail-card:hover .thumbnail-frame {
    border-color: var(--border-bright);
  }

  iframe {
    width: 1280px;
    height: 960px;
    transform: scale(0.219);
    transform-origin: top left;
    pointer-events: none;
    border: none;
    background: white;
    opacity: 0;
    transition: opacity 0.15s;
  }

  iframe.loaded {
    opacity: 1;
  }

  .thumbnail-label {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-0);
    padding: 0 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 280px;
  }

  .thumbnail-sublabel {
    font-size: 11px;
    color: var(--text-2);
    padding: 0 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 280px;
  }
</style>
