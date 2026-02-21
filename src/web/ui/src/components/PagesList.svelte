<script lang="ts">
import type { RecentPage } from "../lib/api";
import { formatRelativeTime } from "../lib/format";

let {
  pages,
  onSelectPage,
}: {
  pages: RecentPage[];
  onSelectPage: (mind: string, path: string) => void;
} = $props();
</script>

<div class="pages-list">
  {#each pages as page (page.url)}
    <button class="page-item" onclick={() => onSelectPage(page.mind, page.file)}>
      <span class="page-label"><span class="page-mind">{page.mind}/</span>{page.file}</span>
      <span class="page-time">{formatRelativeTime(page.modified)}</span>
    </button>
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
    cursor: pointer;
    background: none;
    text-align: left;
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
