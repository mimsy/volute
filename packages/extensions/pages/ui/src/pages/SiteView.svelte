<script lang="ts">
import PageThumbnail from "../components/PageThumbnail.svelte";
import type { Site } from "../lib/api";

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

let {
  site,
  onSelectPage,
}: {
  site: Site;
  onSelectPage: (mind: string, path: string) => void;
} = $props();

const isIndex = (file: string) => file === "index.html" || file === "index.md";

// The index is the site's front door — feature it as a hero, list the rest.
let hero = $derived(site.pages.find((p) => isIndex(p.file)));
let rest = $derived(site.pages.filter((p) => p !== hero));
</script>

<div class="site-view">
  <div class="site-header">
    <span class="site-name">{site.label}</span>
    <span class="page-count">{site.pages.length} {site.pages.length === 1 ? "page" : "pages"}</span>
  </div>

  {#if hero}
    <PageThumbnail
      url={`/ext/pages/public/${site.name}/${hero.file}`}
      label={hero.file}
      sublabel={`home · ${formatRelativeTime(hero.modified)}`}
      onclick={() => onSelectPage(site.name, hero.file)}
      width={600}
      height={340}
    />
  {/if}

  {#if rest.length > 0}
    <div class="thumbnail-grid" class:with-hero={hero}>
      {#each rest as page}
        <PageThumbnail
          url={`/ext/pages/public/${site.name}/${page.file}`}
          label={page.file}
          sublabel={formatRelativeTime(page.modified)}
          onclick={() => onSelectPage(site.name, page.file)}
        />
      {/each}
    </div>
  {/if}

  {#if site.pages.length === 0}
    <div class="empty">No pages in this site.</div>
  {/if}
</div>

<style>
  .site-view { max-width: 1200px; }
  .site-header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 16px; }
  .site-name { font-size: 16px; font-weight: 500; color: var(--text-0); }
  .page-count { font-size: 12px; color: var(--text-2); }
  .thumbnail-grid { display: flex; flex-wrap: wrap; gap: 16px; }
  .thumbnail-grid.with-hero { margin-top: 20px; }
  .empty { color: var(--text-2); font-size: 13px; }
</style>
