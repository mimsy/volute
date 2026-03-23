<script lang="ts">
import PlanCurrent from "./pages/PlanCurrent.svelte";
import PlanHistory from "./pages/PlanHistory.svelte";

let hash = $state(window.location.hash);

$effect(() => {
  const handler = () => {
    hash = window.location.hash;
  };
  window.addEventListener("hashchange", handler);
  return () => window.removeEventListener("hashchange", handler);
});

let view = $derived(hash.replace(/^#\/?/, "") === "history" ? "history" : "current");
</script>

<div class="ext-app">
  {#if view === "history"}
    <PlanHistory onBack={() => { window.location.hash = ""; }} />
  {:else}
    <PlanCurrent onViewHistory={() => { window.location.hash = "history"; }} />
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
