<script lang="ts">
import type { RecentPage } from "../lib/api";
import { formatRelativeTime } from "../lib/format";

let { pages }: { pages: RecentPage[] } = $props();
</script>

<div class="pages-list">
  {#each pages as page (page.url)}
    <a href={page.url} target="_blank" rel="noopener noreferrer" class="page-item">
      <span class="page-label"><span class="page-mind">{page.mind}/</span>{page.file}</span>
      <span class="page-time">{formatRelativeTime(page.modified)}</span>
    </a>
  {/each}
  {#if pages.length === 0}
    <div class="empty">No published pages</div>
  {/if}
</div>

<style>
  .pages-list {
    display: flex;
    flex-direction: column;
  }

  .page-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 12px;
    margin: 0 4px;
    font-size: 11px;
    color: var(--text-1);
    border-radius: var(--radius);
    transition: background 0.1s;
    text-decoration: none;
  }

  .page-item:hover {
    background: var(--bg-2);
  }

  .page-mind {
    color: var(--text-2);
  }

  .page-time {
    color: var(--text-2);
    font-size: 10px;
    flex-shrink: 0;
  }

  .empty {
    color: var(--text-2);
    font-size: 11px;
    padding: 8px 12px;
  }
</style>
