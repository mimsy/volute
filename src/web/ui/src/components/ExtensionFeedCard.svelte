<script lang="ts">
import { formatRelativeTime } from "../lib/format";
import { renderMarkdown } from "../lib/markdown";

let {
  title,
  url,
  date,
  author,
  bodyHtml,
  iframeUrl,
  icon,
  color,
  onclick,
}: {
  title: string;
  url: string;
  date: string;
  author?: string;
  bodyHtml: string;
  iframeUrl?: string;
  icon?: string;
  color?: string;
  onclick?: () => void;
} = $props();

let renderedBody = $derived(renderMarkdown(bodyHtml));
let cardColor = $derived(color ? `var(--${color})` : "var(--text-2)");
let iframeLoaded = $state(false);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="feed-card"
  role="button"
  tabindex="0"
  onclick={onclick}
  onkeydown={(e) => { if (e.key === 'Enter') onclick?.(); }}
  style:border-color="color-mix(in srgb, {cardColor} 25%, var(--border))"
>
  <div class="feed-card-header" style:border-bottom-color="color-mix(in srgb, {cardColor} 25%, var(--border))">
    {#if icon}
      <span class="feed-card-icon" style:color={cardColor}>{@html icon}</span>
    {/if}
    <span class="feed-card-label">{title}</span>
    {#if author}
      <span class="feed-card-author">{author}</span>
    {/if}
    <span class="feed-card-meta">{formatRelativeTime(date)}</span>
  </div>
  {#if iframeUrl || bodyHtml}
    <div class="feed-card-body">
      {#if iframeUrl}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <iframe
          src={iframeUrl}
          class="page-preview"
          class:loaded={iframeLoaded}
          title={title}
          sandbox="allow-same-origin"
          onpointerdown={(e) => e.preventDefault()}
          onload={() => iframeLoaded = true}
        ></iframe>
      {:else}
        <div class="body-html markdown-body">{@html renderedBody}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .feed-card {
    background: var(--bg-0);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    display: flex;
    flex-direction: column;
    max-height: 240px;
    overflow: hidden;
    transition: border-color 0.15s;
    cursor: pointer;
  }

  .feed-card:hover {
    border-color: var(--border-bright);
  }

  .feed-card-header {
    padding: 6px 8px 6px 10px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-1);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .feed-card-icon {
    display: flex;
    flex-shrink: 0;
  }

  .feed-card-icon :global(svg) {
    width: 14px;
    height: 14px;
  }

  .feed-card-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }

  .feed-card-author {
    font-size: 11px;
    color: var(--accent);
    flex-shrink: 0;
  }

  .feed-card-meta {
    font-size: 11px;
    color: var(--text-2);
    font-weight: 400;
    flex-shrink: 0;
    margin-left: auto;
  }

  .feed-card-body {
    flex: 1;
    overflow: hidden;
    min-height: 0;
  }

  .body-html {
    padding: 8px 12px;
    font-size: 13px;
    color: var(--text-0);
    line-height: 1.5;
    overflow: hidden;
    height: 100%;
  }

  .page-preview {
    width: 100%;
    height: 100%;
    border: none;
    pointer-events: none;
    background: white;
    opacity: 0;
    transition: opacity 0.15s;
  }

  .page-preview.loaded {
    opacity: 1;
  }
</style>
