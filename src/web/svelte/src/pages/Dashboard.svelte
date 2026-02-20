<script lang="ts">
import MindCard from "../components/MindCard.svelte";
import SeedModal from "../components/SeedModal.svelte";
import { fetchMinds, type Mind } from "../lib/api";
import { navigate } from "../lib/navigate";

let minds = $state<Mind[]>([]);
let error = $state("");
let loading = $state(true);
let showSeedModal = $state(false);

$effect(() => {
  let active = true;
  const poll = async () => {
    try {
      const data = await fetchMinds();
      if (active) {
        minds = data;
        error = "";
        loading = false;
      }
    } catch {
      if (active) {
        error = "Failed to connect to API";
        loading = false;
      }
    }
  };

  poll();
  const interval = setInterval(poll, 5000);
  return () => {
    active = false;
    clearInterval(interval);
  };
});

function handleSeedCreated(mindName: string) {
  showSeedModal = false;
  navigate(`/chats?mind=${mindName}`);
}
</script>

{#if error}
  <div class="error">{error}</div>
{:else if loading}
  <!-- loading -->
{:else if minds.length === 0}
  <div class="empty">
    <div class="empty-text">No minds registered.</div>
    <div class="empty-actions">
      <code class="code-hint">volute mind create &lt;name&gt;</code>
      <span class="or">or</span>
      <button class="seed-btn" onclick={() => showSeedModal = true}>plant a seed</button>
    </div>
  </div>
{:else}
  <div class="toolbar">
    <button class="seed-btn" onclick={() => showSeedModal = true}>plant a seed</button>
  </div>
  <div class="grid">
    {#each minds as mind, i}
      <div class="card-wrapper" style:animation-delay={`${i * 50}ms`}>
        <MindCard {mind} />
      </div>
    {/each}
  </div>
{/if}

{#if showSeedModal}
  <SeedModal onClose={() => showSeedModal = false} onCreated={handleSeedCreated} />
{/if}

<style>
  .error {
    color: var(--red);
    padding: 40px;
    text-align: center;
  }

  .empty {
    color: var(--text-2);
    padding: 40px;
    text-align: center;
    font-size: 14px;
  }

  .empty-text {
    margin-bottom: 8px;
  }

  .empty-actions {
    display: flex;
    gap: 12px;
    justify-content: center;
    margin-top: 16px;
  }

  .code-hint {
    color: var(--text-1);
  }

  .or {
    color: var(--text-2);
  }

  .seed-btn {
    padding: 6px 14px;
    background: rgba(251, 191, 36, 0.08);
    color: var(--yellow);
    border-radius: var(--radius);
    font-size: 12px;
    font-weight: 500;
    border: 1px solid rgba(251, 191, 36, 0.2);
    cursor: pointer;
  }

  .toolbar {
    margin-bottom: 16px;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 16px;
    max-width: 1200px;
  }

  .card-wrapper {
    animation: fadeIn 0.3s ease both;
  }
</style>
