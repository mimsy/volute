<script lang="ts">
import type { AvailableUser, Mind } from "@volute/api";
import { onMount } from "svelte";
import { fetchAvailableUsers } from "../lib/client";
import { mindDotColor } from "../lib/format";
import Modal from "./Modal.svelte";

let {
  minds,
  onClose,
  onPick,
}: {
  minds: Mind[];
  onClose: () => void;
  onPick: (name: string) => void;
} = $props();

let users = $state<AvailableUser[]>([]);
let query = $state("");
let loading = $state(true);
let error = $state("");
let inputEl = $state<HTMLInputElement | null>(null);

onMount(() => {
  fetchAvailableUsers()
    .then((u) => {
      users = u;
      loading = false;
      inputEl?.focus();
    })
    .catch(() => {
      loading = false;
      error = "Failed to load users";
    });
});

let filtered = $derived(
  users.filter((u) => u.username.toLowerCase().includes(query.toLowerCase())),
);

function mindForUser(username: string): Mind | undefined {
  return minds.find((m) => m.name === username);
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    if (filtered.length > 0) {
      onPick(filtered[0].username);
    }
  } else if (e.key === "Escape") {
    onClose();
  }
}
</script>

<Modal size="300px" {onClose}>
  <div class="modal-content">
    <div class="modal-title">New conversation</div>

    {#if loading}
      <div class="hint">Loading users...</div>
    {:else if error}
      <div class="error">{error}</div>
    {:else}
      <input
        bind:this={inputEl}
        bind:value={query}
        placeholder="Search users..."
        class="search-input"
        onkeydown={handleKeydown}
      />

      <div class="user-list">
        {#each filtered as u}
          {@const mind = mindForUser(u.username)}
          <button class="user-item" onclick={() => onPick(u.username)}>
            {#if mind}
              <span
                class="dot"
                style:background={mindDotColor(mind)}
                style:box-shadow={mindDotColor(mind) !== "var(--text-2)" ? `0 0 4px ${mindDotColor(mind)}` : "none"}
              ></span>
            {/if}
            <span class="item-name">{u.username}</span>
            {#if u.user_type === "mind"}
              <span class="item-badge">mind</span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>
</Modal>

<style>
  .modal-content {
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-height: 60vh;
    overflow: hidden;
  }

  .modal-title {
    font-weight: 600;
    color: var(--text-0);
    font-size: 15px;
  }

  .hint {
    color: var(--text-2);
    font-size: 12px;
    padding: 8px;
  }

  .error {
    color: var(--red);
    font-size: 12px;
  }

  .search-input {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px 10px;
    color: var(--text-0);
    font-size: 13px;
    outline: none;
    font-family: inherit;
  }

  .search-input:focus {
    border-color: var(--accent);
  }

  .search-input::placeholder {
    color: var(--text-2);
  }

  .user-list {
    overflow-y: auto;
    max-height: 300px;
  }

  .user-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 10px;
    cursor: pointer;
    font-size: 13px;
    color: var(--text-0);
    background: none;
    border-radius: var(--radius);
    text-align: left;
  }

  .user-item:hover {
    background: var(--bg-2);
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .item-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .item-badge {
    color: var(--accent);
    font-size: 11px;
    flex-shrink: 0;
  }
</style>
