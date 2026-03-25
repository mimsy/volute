<script lang="ts">
import { onMount } from "svelte";
import { fetchPagesData, type Site } from "./lib/api";
import PagesDashboard from "./pages/PagesDashboard.svelte";
import SiteView from "./pages/SiteView.svelte";

let hash = $state(window.location.hash);

onMount(() => {
  const handler = () => {
    hash = window.location.hash;
  };
  window.addEventListener("hashchange", handler);
  return () => window.removeEventListener("hashchange", handler);
});

type Route =
  | { view: "dashboard" }
  | { view: "site"; name: string }
  | { view: "page"; name: string; path: string }
  | { view: "mind"; name: string };

let route = $derived.by((): Route => {
  const h = hash.replace(/^#\/?/, "");

  // #/mind/{name} → mind-scoped site
  const mindMatch = h.match(/^mind\/([^/]+)/);
  if (mindMatch) return { view: "mind", name: mindMatch[1] };

  // #/{name}/{path...} → individual page view
  const pageMatch = h.match(/^([^/]+)\/(.+)$/);
  if (pageMatch) return { view: "page", name: pageMatch[1], path: pageMatch[2] };

  // #/{name} → site view
  if (h && !h.includes("/")) return { view: "site", name: h };

  return { view: "dashboard" };
});

let sites = $state<Site[]>([]);
let systemSite = $state<Site | null>(null);
let recentPages = $state<any[]>([]);

$effect(() => {
  fetchPagesData().then((data) => {
    sites = data.sites;
    systemSite = data.systemSite;
    recentPages = data.recentPages;
  });
});

let allSites = $derived([...(systemSite ? [systemSite] : []), ...sites]);

let selectedSite = $derived.by(() => {
  if (route.view === "site") return allSites.find((s) => s.name === route.name);
  if (route.view === "mind") return allSites.find((s) => s.name === route.name);
  return undefined;
});

function navigateParent(path: string) {
  window.parent.postMessage({ type: "navigate", path }, "*");
}

function handleIframeNav(e: Event) {
  const iframe = e.target as HTMLIFrameElement;
  try {
    const path = iframe.contentWindow?.location.pathname;
    if (!path) return;
    // Match /ext/pages/public/{name}/{file...}
    const match = path.match(/^\/ext\/pages\/public\/([^/]+)\/(.+)$/);
    if (!match) return;
    const [, mind, file] = match;
    if (mind === route.name && file === (route as { path?: string }).path) return;
    if (mind === "_system") {
      navigateParent(`/pages/_system/${file}`);
    } else {
      navigateParent(`/minds/${mind}/pages/${file}`);
    }
  } catch {
    // cross-origin or security error — ignore
  }
}

function handleSelectPage(mind: string, path: string) {
  if (mind === "_system") {
    navigateParent(`/pages/_system/${path}`);
  } else {
    navigateParent(`/minds/${mind}/pages/${path}`);
  }
}

function handleSelectSite(name: string) {
  if (name === "_system") {
    navigateParent(`/pages/_system`);
  } else {
    navigateParent(`/minds/${name}/pages`);
  }
}
</script>

<div class="ext-app" class:full-page={route.view === "page"}>
  {#if route.view === "page"}
    <iframe
      src="/ext/pages/public/{route.name}/{route.path}"
      class="full-page-iframe"
      title="{route.name}/{route.path}"
      onload={handleIframeNav}
    ></iframe>
  {:else if (route.view === "site" || route.view === "mind") && selectedSite}
    <SiteView site={selectedSite} onSelectPage={handleSelectPage} />
  {:else}
    <PagesDashboard {sites} {systemSite} {recentPages} onSelectSite={handleSelectSite} onSelectPage={handleSelectPage} />
  {/if}
</div>

<style>
  .ext-app {
    padding: 24px;
    max-width: 100%;
    min-height: 100%;
    animation: fadeIn 0.2s ease both;
  }

  .ext-app.full-page {
    padding: 0;
    height: 100%;
  }

  .full-page-iframe {
    width: 100%;
    height: 100%;
    border: none;
    background: white;
  }
</style>
