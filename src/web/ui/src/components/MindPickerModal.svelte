<script lang="ts">
import { fetchMinds, type Mind } from "../lib/api";

let { onClose, onPick }: { onClose: () => void; onPick: (mindName: string) => void } = $props();

let minds = $state<Mind[]>([]);
let loading = $state(true);
let error = $state("");

$effect(() => {
  fetchMinds()
    .then((m) => {
      minds = m;
      loading = false;
    })
    .catch(() => {
      loading = false;
      error = "Failed to load minds";
    });
});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="overlay" onclick={onClose} onkeydown={() => {}}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
    <div class="modal-title">New chat with...</div>
    {#if loading}
      <div class="loading">Loading minds...</div>
    {:else if error}
      <div class="error">{error}</div>
    {:else}
      <div class="mind-list">
        {#each minds as mind}
          <button class="mind-option" onclick={() => onPick(mind.name)}>
            <span class="status-dot" class:running={mind.status === "running"}></span>
            {mind.name}
          </button>
        {/each}
        {#if minds.length === 0}
          <div class="loading">No minds found</div>
        {/if}
      </div>
    {/if}
    <button class="cancel-btn" onclick={onClose}>Cancel</button>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .modal {
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 20px;
    width: 280px;
    max-height: 50vh;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .modal-title {
    font-weight: 600;
    color: var(--text-0);
    font-size: 14px;
  }

  .loading {
    color: var(--text-2);
    font-size: 12px;
    padding: 8px;
  }

  .error {
    color: var(--red);
    font-size: 12px;
    padding: 8px;
  }

  .mind-list {
    flex: 1;
    overflow: auto;
  }

  .mind-option {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 10px;
    background: transparent;
    color: var(--text-0);
    font-size: 13px;
    border-radius: var(--radius);
    text-align: left;
    transition: background 0.1s;
  }

  .mind-option:hover {
    background: var(--bg-2);
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-2);
    flex-shrink: 0;
  }

  .status-dot.running {
    background: var(--accent);
  }

  .cancel-btn {
    padding: 6px 14px;
    background: var(--bg-2);
    color: var(--text-1);
    border-radius: var(--radius);
    font-size: 12px;
    border: 1px solid var(--border);
    align-self: flex-end;
  }
</style>
