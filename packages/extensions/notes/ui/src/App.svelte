<script lang="ts">
import { onMount } from "svelte";
import { fetchCurrentUsername } from "./lib/api";
import NoteDetail from "./pages/NoteDetail.svelte";
import NotesList from "./pages/NotesList.svelte";

let hash = $state(window.location.hash);
let username = $state("");

onMount(() => {
  fetchCurrentUsername().then((u) => {
    username = u;
  });
  const handler = () => {
    hash = window.location.hash;
  };
  window.addEventListener("hashchange", handler);
  return () => window.removeEventListener("hashchange", handler);
});

type Route =
  | { view: "list"; author?: string; mindContext?: string }
  | { view: "detail"; author: string; slug: string; mindContext?: string };

let route = $derived.by((): Route => {
  const h = hash.replace(/^#\/?/, "");

  // #/mind/{name} → filtered list (mind context)
  // #/mind/{name}/{slug} → detail in mind context
  const mindMatch = h.match(/^mind\/([^/]+)(?:\/(.+))?/);
  if (mindMatch) {
    if (mindMatch[2])
      return {
        view: "detail",
        author: mindMatch[1],
        slug: mindMatch[2],
        mindContext: mindMatch[1],
      };
    return { view: "list", author: mindMatch[1], mindContext: mindMatch[1] };
  }

  // #/{author}/{slug} → detail
  const detailMatch = h.match(/^([^/]+)\/(.+)/);
  if (detailMatch) return { view: "detail", author: detailMatch[1], slug: detailMatch[2] };

  // Default: list
  return { view: "list" };
});

function navigateHash(path: string) {
  window.location.hash = path;
}

function navigateParent(path: string) {
  window.parent.postMessage({ type: "navigate", path }, "*");
}

function noteUrl(author: string, slug: string): string {
  return `/minds/${author}/notes/${slug}`;
}
</script>

<div class="ext-app">
  {#if route.view === "detail"}
    <NoteDetail
      author={route.author}
      slug={route.slug}
      {username}
      onNavigate={(author, slug) => navigateParent(noteUrl(author, slug))}
      onBack={() => navigateParent(route.mindContext ? `/minds/${route.mindContext}/notes` : "/notes")}
    />
  {:else}
    <NotesList
      author={route.author}
      onSelectNote={(author, slug) => navigateParent(noteUrl(author, slug))}
    />
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
