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

// Comment drawer state for the single-page view. The thread stays mounted while
// the drawer is closed (it slides off-screen) so its count is known before the
// visitor ever opens it.
let threadOpen = $state(false);
let commentCount = $state(0);

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

// Moving to a different page closes the drawer and clears the badge; the freshly
// mounted thread reports the new page's count.
$effect(() => {
  const key = route.view === "page" ? `${route.name}/${route.path}` : "";
  void key;
  threadOpen = false;
  commentCount = 0;
});

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && threadOpen) {
    e.preventDefault();
    threadOpen = false;
  }
}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="ext-app" class:full-page={route.view === "page"}>
  {#if route.view === "page"}
    <div class="page-view">
      <iframe
        bind:this={pageIframe}
        src="/ext/pages/public/{route.name}/{route.path}"
        class="full-page-iframe"
        title="{route.name}/{route.path}"
      ></iframe>

      {#if threadOpen}
        <div
          class="thread-scrim"
          role="presentation"
          onclick={() => (threadOpen = false)}
        ></div>
      {/if}

      <aside class="thread-drawer" class:open={threadOpen} aria-hidden={!threadOpen}>
        <header class="drawer-header">
          <span class="drawer-title">Comments</span>
          <button
            class="drawer-close"
            onclick={() => (threadOpen = false)}
            aria-label="Close comments"
          >✕</button>
        </header>
        <div class="drawer-body">
          <PageThread
            mind={route.name}
            file={route.path}
            currentUsername={username}
            {userAvatarUrl}
            onCount={(n) => (commentCount = n)}
          />
        </div>
      </aside>

      <button
        class="comments-fab"
        class:empty={commentCount === 0}
        class:hidden={threadOpen}
        onclick={() => (threadOpen = true)}
        aria-label={commentCount > 0 ? `Comments (${commentCount})` : "Comments"}
      >
        <svg
          class="fab-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z" />
        </svg>
        {#if commentCount > 0}
          <span class="fab-badge">{commentCount}</span>
        {/if}
      </button>
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

  /* The page fills the view; the conversation overlays it on request rather than
     reflowing it, so a visitor never has to scroll past the whole page to find
     that a conversation exists. */
  .page-view {
    position: relative;
    height: 100%;
    width: 100%;
    overflow: hidden;
  }

  .full-page-iframe {
    display: block;
    width: 100%;
    height: 100%;
    border: none;
    background: white;
  }

  /* Floating affordance, bottom-right. Present even at zero (subtler) so adding
     the first comment is discoverable; the badge appears once there's something
     to count. */
  .comments-fab {
    position: absolute;
    right: 20px;
    bottom: 20px;
    z-index: var(--z-dropdown);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 48px;
    height: 48px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--bg-2);
    color: var(--text-1);
    cursor: pointer;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.28);
    transition:
      transform 0.15s,
      color 0.15s,
      border-color 0.15s,
      opacity 0.15s;
  }

  .comments-fab:hover {
    color: var(--text-0);
    border-color: var(--border-bright);
    transform: translateY(-1px);
  }

  .comments-fab.empty {
    opacity: 0.6;
  }

  .comments-fab.empty:hover {
    opacity: 1;
  }

  .comments-fab.hidden {
    opacity: 0;
    pointer-events: none;
  }

  .fab-icon {
    width: 22px;
    height: 22px;
  }

  .fab-badge {
    position: absolute;
    top: -4px;
    right: -4px;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 999px;
    background: var(--accent);
    color: var(--bg-0);
    font-family: var(--sans);
    font-size: 11px;
    font-weight: 600;
    line-height: 18px;
    text-align: center;
    box-sizing: border-box;
  }

  .thread-scrim {
    position: absolute;
    inset: 0;
    z-index: var(--z-modal);
    background: var(--overlay);
    animation: fadeIn 0.15s ease;
  }

  .thread-drawer {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(420px, 100%);
    z-index: var(--z-modal);
    display: flex;
    flex-direction: column;
    background: var(--bg-1);
    border-left: 1px solid var(--border);
    box-shadow: -8px 0 24px rgba(0, 0, 0, 0.28);
    transform: translateX(100%);
    transition: transform 0.2s ease;
  }

  .thread-drawer.open {
    transform: translateX(0);
  }

  .drawer-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .drawer-title {
    font-family: var(--sans);
    font-size: 14px;
    font-weight: 600;
    color: var(--text-0);
  }

  .drawer-close {
    background: none;
    border: none;
    color: var(--text-2);
    font-size: 15px;
    line-height: 1;
    padding: 4px 8px;
    cursor: pointer;
  }

  .drawer-close:hover {
    color: var(--text-0);
  }

  .drawer-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  /* The drawer supplies its own header/border, so drop the thread's own top rule
     and let it size to the drawer rather than a capped fraction of the page. */
  .drawer-body :global(.thread) {
    border-top: none;
    max-height: none;
  }
</style>
