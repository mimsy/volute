<script lang="ts">
import PageThumbnail from "../components/PageThumbnail.svelte";
import type { RecentPage, Site } from "../lib/api";
import { formatRelativeTime } from "../lib/format";

let {
  sites,
  recentPages,
  onSelectSite,
  onSelectPage,
}: {
  sites: Site[];
  recentPages: RecentPage[];
  onSelectSite: (name: string) => void;
  onSelectPage: (mind: string, path: string) => void;
} = $props();
</script>

<div class="dashboard">
  {#if sites.length > 0}
    <div class="section">
      <div class="section-header">
        <span class="section-title">sites</span>
      </div>
      <div class="thumbnail-grid">
        {#each sites as site}
          <PageThumbnail
            url={site.pages[0]?.url ?? ""}
            label={site.label}
            onclick={() => onSelectSite(site.name)}
          />
        {/each}
      </div>
    </div>
  {/if}

  {#if recentPages.length > 0}
    <div class="section">
      <div class="section-header">
        <span class="section-title">recently modified</span>
      </div>
      <div class="thumbnail-grid">
        {#each recentPages as page}
          <PageThumbnail
            url={page.url}
            label={page.file}
            sublabel="{page.mind} · {formatRelativeTime(page.modified)}"
            onclick={() => onSelectPage(page.mind, page.file)}
          />
        {/each}
      </div>
    </div>
  {/if}

  {#if sites.length === 0 && recentPages.length === 0}
    <div class="empty">No pages published yet.</div>
  {/if}
</div>

<style>
  .dashboard {
    max-width: 1200px;
    animation: fadeIn 0.2s ease both;
  }

  .section {
    margin-bottom: 24px;
  }

  .section-header {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 12px;
  }

  .section-title {
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
