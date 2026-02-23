<script lang="ts">
import PageThumbnail from "../components/PageThumbnail.svelte";
import type { Site } from "../lib/api";
import { formatRelativeTime } from "../lib/format";

let {
  site,
  onSelectPage,
}: {
  site: Site;
  onSelectPage: (mind: string, path: string) => void;
} = $props();
</script>

<div class="site-view">
  <div class="site-header">
    <span class="site-name">{site.label}</span>
    <span class="page-count">{site.pages.length} {site.pages.length === 1 ? "page" : "pages"}</span>
  </div>

  <div class="thumbnail-grid">
    {#each site.pages as page}
      <PageThumbnail
        url={page.url}
        label={page.file}
        sublabel={formatRelativeTime(page.modified)}
        onclick={() => onSelectPage(site.name, page.file)}
      />
    {/each}
  </div>

  {#if site.pages.length === 0}
    <div class="empty">No pages in this site.</div>
  {/if}
</div>

<style>
  .site-view {
    max-width: 1200px;
    animation: fadeIn 0.2s ease both;
  }

  .site-header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 16px;
  }

  .site-name {
    font-size: 16px;
    font-weight: 500;
    color: var(--text-0);
  }

  .page-count {
    font-size: 11px;
    color: var(--text-2);
  }

  .thumbnail-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
  }

  .empty {
    color: var(--text-2);
    font-size: 12px;
  }
</style>
