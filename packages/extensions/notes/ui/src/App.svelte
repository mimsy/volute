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

type Route = { view: "list"; author?: string } | { view: "detail"; author: string; slug: string };

let route = $derived.by((): Route => {
  const h = hash.replace(/^#\/?/, "");

  // #/mind/{name} → filtered list
  const mindMatch = h.match(/^mind\/([^/]+)/);
  if (mindMatch) return { view: "list", author: mindMatch[1] };

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
</script>

<div class="ext-app">
  {#if route.view === "detail"}
    <NoteDetail
      author={route.author}
      slug={route.slug}
      {username}
      onNavigate={(author, slug) => navigateParent(`/notes/${author}/${slug}`)}
      onBack={() => navigateHash("")}
    />
  {:else}
    <NotesList
      author={route.author}
      onSelectNote={(author, slug) => navigateParent(`/notes/${author}/${slug}`)}
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
