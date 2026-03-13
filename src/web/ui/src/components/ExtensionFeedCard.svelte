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
  onclick,
}: {
  title: string;
  url: string;
  date: string;
  author?: string;
  bodyHtml: string;
  iframeUrl?: string;
  onclick?: () => void;
} = $props();

let renderedBody = $derived(renderMarkdown(bodyHtml));
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="feed-card" role="button" tabindex="0" onclick={onclick} onkeydown={(e) => { if (e.key === 'Enter') onclick?.(); }}>
  <div class="feed-card-header">
    <span class="feed-card-label">{title}</span>
    {#if author}
      <span class="feed-card-author">{author}</span>
    {/if}
    <span class="feed-card-meta">{formatRelativeTime(date)}</span>
  </div>
  <div class="feed-card-body">
    {#if iframeUrl}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <iframe
        src={iframeUrl}
        class="page-preview"
        title={title}
        sandbox="allow-same-origin"
        onpointerdown={(e) => e.preventDefault()}
      ></iframe>
    {:else}
      <div class="body-html markdown-body">{@html renderedBody}</div>
    {/if}
  </div>
</div>

<style>
  .feed-card {
    background: var(--bg-0);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    display: flex;
    flex-direction: column;
    height: 240px;
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
  }
</style>
