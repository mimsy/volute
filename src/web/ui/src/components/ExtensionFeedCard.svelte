<script lang="ts">
let {
  title,
  url,
  date,
  author,
  bodyHtml,
  onclick,
}: {
  title: string;
  url: string;
  date: string;
  author?: string;
  bodyHtml: string;
  onclick?: () => void;
} = $props();

function sanitizeHtml(html: string): string {
  // Strip script tags, event handlers, and dangerous attributes
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\bon\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\bon\w+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "");
}

function relativeTime(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
</script>

<button class="card" {onclick}>
  <div class="header">
    <h3 class="title">{title}</h3>
    <span class="date">{relativeTime(date)}</span>
  </div>
  <div class="body">{@html sanitizeHtml(bodyHtml)}</div>
  {#if author}
    <div class="meta">
      <span class="author">{author}</span>
    </div>
  {/if}
</button>

<style>
  .card {
    display: block;
    width: 100%;
    padding: 20px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    cursor: pointer;
    transition: all 0.15s ease;
    text-align: left;
    font-family: var(--sans);
  }

  .card:hover {
    border-color: var(--border-bright);
  }

  .header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
  }

  .title {
    font-family: var(--display);
    font-size: 17px;
    font-weight: 400;
    color: var(--text-0);
    margin: 0;
  }

  .date {
    font-size: 12px;
    color: var(--text-2);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .body {
    font-size: 14px;
    color: var(--text-1);
    margin: 0 0 12px;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    line-height: 1.5;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 16px;
    font-size: 13px;
  }

  .author {
    color: var(--accent);
  }
</style>
