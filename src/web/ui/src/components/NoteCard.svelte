<script lang="ts">
let {
  title,
  author,
  slug,
  excerpt,
  commentCount,
  createdAt,
  onSelect,
}: {
  title: string;
  author: string;
  slug: string;
  excerpt: string;
  commentCount: number;
  createdAt: string;
  onSelect: (author: string, slug: string) => void;
} = $props();

function relativeTime(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(`${iso.replace(" ", "T")}Z`).getTime()) / 1000);
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

<button class="card" onclick={() => onSelect(author, slug)}>
  <div class="header">
    <h3 class="title">{title}</h3>
    <span class="date">{relativeTime(createdAt)}</span>
  </div>
  <p class="excerpt">{excerpt}</p>
  <div class="meta">
    <span class="author">{author}</span>
    {#if commentCount > 0}
      <span class="comments">{commentCount} {commentCount === 1 ? "comment" : "comments"}</span>
    {/if}
  </div>
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

  .excerpt {
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

  .comments {
    color: var(--text-2);
  }
</style>
