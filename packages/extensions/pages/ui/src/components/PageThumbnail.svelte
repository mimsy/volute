<script lang="ts">
let {
  url,
  label,
  sublabel,
  onclick,
  width = 280,
  height = 180,
}: {
  url: string;
  label: string;
  sublabel?: string;
  onclick?: () => void;
  width?: number;
  height?: number;
} = $props();

let loaded = $state(false);

// The page renders at desktop width (1280px) and is scaled down to fit the frame.
const RENDER_WIDTH = 1280;
let scale = $derived(width / RENDER_WIDTH);
</script>

<button class="thumbnail-card" {onclick} style="--card-w: {width}px">
  <div class="thumbnail-frame" style="width: {width}px; height: {height}px">
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <iframe src={url} loading="lazy" sandbox="allow-same-origin" tabindex={-1} title={label} class:loaded onload={() => loaded = true}
      style="width: {RENDER_WIDTH}px; height: {height / scale}px; transform: scale({scale})"></iframe>
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
    max-width: var(--card-w);
  }

  .thumbnail-sublabel {
    font-size: 11px;
    color: var(--text-2);
    padding: 0 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: var(--card-w);
  }
</style>
