<script lang="ts">
import { onMount } from "svelte";
import PageThread from "./components/PageThread.svelte";
import { fetchCurrentUser, fetchPagesData, type Site } from "./lib/api";
import PagesDashboard from "./pages/PagesDashboard.svelte";
import SiteView from "./pages/SiteView.svelte";

let hash = $state(window.location.hash);
let pageIframe = $state<HTMLIFrameElement>();
let username = $state("");
let userAvatarUrl = $state<string | null>(null);

onMount(() => {
  fetchCurrentUser().then((u) => {
    username = u.username;
    userAvatarUrl = u.avatarUrl;
  });
  const handler = () => {
    hash = window.location.hash;
  };
  window.addEventListener("hashchange", handler);
  window.addEventListener("message", handlePageMessage);
  return () => {
    window.removeEventListener("hashchange", handler);
    window.removeEventListener("message", handlePageMessage);
  };
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
  if (route.view !== "site" && route.view !== "mind") return undefined;
  const name = route.name;
  // Fall back to an empty site so a mind with no pages shows "no pages"
  // instead of the system-wide dashboard.
  return allSites.find((s) => s.name === name) ?? { name, label: name, pages: [] };
});

function navigateParent(path: string) {
  window.parent.postMessage({ type: "navigate", path }, "*");
}

// Sync the outer breadcrumb from a page path (`/ext/pages/public/{mind}/{file}`).
// The path is untrusted — we only ever derive a pages route from it, never an
// arbitrary app route.
function syncBreadcrumbFromPath(path: string) {
  const match = path.match(/^\/ext\/pages\/public\/([^/]+)\/(.+)$/);
  if (!match) return;
  const [, mind, file] = match;
  if (route.view === "page" && mind === route.name && file === route.path) return;
  if (mind === "_system") {
    navigateParent(`/pages/_system/${file}`);
  } else {
    navigateParent(`/minds/${mind}/pages/${file}`);
  }
}

// Sandboxed pages can't have their location read cross-origin, so they report it
// to us via postMessage (see NAV_SHIM in the pages server). Only trust messages
// coming from the page iframe we mounted.
function handlePageMessage(e: MessageEvent) {
  if (e.source !== pageIframe?.contentWindow) return;
  const data = e.data;
  if (data?.type !== "volute-pages-nav" || typeof data.path !== "string") return;
  syncBreadcrumbFromPath(data.path);
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
    <div class="page-with-thread">
      <iframe
        bind:this={pageIframe}
        src="/ext/pages/public/{route.name}/{route.path}"
        class="full-page-iframe"
        title="{route.name}/{route.path}"
      ></iframe>
      <PageThread
        mind={route.name}
        file={route.path}
        currentUsername={username}
        {userAvatarUrl}
      />
    </div>
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

  .page-with-thread {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .full-page-iframe {
    width: 100%;
    flex: 1 1 60%;
    min-height: 0;
    border: none;
    background: white;
  }

  /* The thread sits under the page rather than beside it: a page is the thing,
     and the conversation is what has gathered under it. Capped so a long thread
     never crowds out the page it is about. */
  .page-with-thread :global(.thread) {
    flex: 0 1 auto;
    max-height: 40%;
  }
</style>
