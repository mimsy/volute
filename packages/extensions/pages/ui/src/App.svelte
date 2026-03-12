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
  | { view: "mind"; name: string };

let route = $derived.by((): Route => {
  const h = hash.replace(/^#\/?/, "");

  // #/mind/{name} → mind-scoped site
  const mindMatch = h.match(/^mind\/([^/]+)/);
  if (mindMatch) return { view: "mind", name: mindMatch[1] };

  // #/{name} → site view
  if (h && !h.includes("/")) return { view: "site", name: h };

  return { view: "dashboard" };
});

let sites = $state<Site[]>([]);
let recentPages = $state<any[]>([]);

$effect(() => {
  fetchPagesData().then((data) => {
    sites = data.sites;
    recentPages = data.recentPages;
  });
});

let selectedSite = $derived.by(() => {
  if (route.view === "site") return sites.find((s) => s.name === route.name);
  if (route.view === "mind") return sites.find((s) => s.name === route.name);
  return undefined;
});

function navigateParent(path: string) {
  window.parent.postMessage({ type: "navigate", path }, "*");
}

function handleSelectPage(mind: string, path: string) {
  navigateParent(`/minds/${mind}/pages/${path}`);
}

function handleSelectSite(name: string) {
  if (name !== "_system") {
    navigateParent(`/minds/${name}/pages`);
  } else {
    window.location.hash = `#/${name}`;
  }
}
</script>

<div class="ext-app">
  {#if (route.view === "site" || route.view === "mind") && selectedSite}
    <SiteView site={selectedSite} onSelectPage={handleSelectPage} />
  {:else}
    <PagesDashboard {sites} {recentPages} onSelectSite={handleSelectSite} onSelectPage={handleSelectPage} />
  {/if}
</div>

<style>
  .ext-app {
    padding: 24px;
    max-width: 100%;
    min-height: 100%;
    animation: fadeIn 0.2s ease both;
  }
</style>
