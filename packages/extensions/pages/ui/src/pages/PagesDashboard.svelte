<script lang="ts">
import PageThumbnail from "../components/PageThumbnail.svelte";
import type { RecentPage, Site } from "../lib/api";

function formatRelativeTime(iso: string): string {
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

function recentSublabel(page: RecentPage): string {
  const time = formatRelativeTime(page.modified);
  if (page.mind === "_system" && page.author) return `${page.author} · ${time}`;
  return `${page.mind} · ${time}`;
}

let {
  sites,
  systemSite,
  recentPages,
  onSelectSite,
  onSelectPage,
}: {
  sites: Site[];
  systemSite: Site | null;
  recentPages: RecentPage[];
  onSelectSite: (name: string) => void;
  onSelectPage: (mind: string, path: string) => void;
} = $props();
</script>

<div class="dashboard">
  {#if systemSite}
    <div class="section">
      <div class="section-header">
        <span class="section-title">shared pages</span>
      </div>
      <div class="thumbnail-grid">
        {#each systemSite.pages as page}
          <PageThumbnail
            url={page.url}
            label={page.file}
            sublabel={page.author ?? undefined}
            onclick={() => onSelectPage("_system", page.file)}
          />
        {/each}
      </div>
    </div>
  {/if}

  {#if sites.length > 0}
    <div class="section">
      <div class="section-header">
        <span class="section-title">mind sites</span>
      </div>
      <div class="thumbnail-grid">
        {#each sites as site}
          <PageThumbnail
            url={site.pages[0] ? `/ext/pages/public/${site.name}/${site.pages[0].file}` : "about:blank"}
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
            url={`/ext/pages/public/${page.mind}/${page.file}`}
            label={page.file}
            sublabel={recentSublabel(page)}
            onclick={() => onSelectPage(page.mind, page.file)}
          />
        {/each}
      </div>
    </div>
  {/if}

  {#if !systemSite && sites.length === 0 && recentPages.length === 0}
    <div class="empty">No pages published yet.</div>
  {/if}
</div>

<style>
  .dashboard { max-width: 1200px; }
  .section { margin-bottom: 24px; }
  .section-header { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; }
  .section-title { color: var(--text-2); }
  .thumbnail-grid { display: flex; flex-wrap: wrap; gap: 16px; }
  .empty { color: var(--text-2); font-size: 13px; }
</style>
