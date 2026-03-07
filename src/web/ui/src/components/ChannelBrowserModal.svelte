<script lang="ts">
import type { ChannelInfo, Conversation } from "@volute/api";
import { onMount } from "svelte";
import {
  createVoluteChannel,
  fetchChannels,
  joinVoluteChannel,
  leaveVoluteChannel,
} from "../lib/client";
import Modal from "./Modal.svelte";

let {
  onClose,
  onJoined,
}: {
  onClose: () => void;
  onJoined: (conv: Conversation) => void;
} = $props();

let channels = $state<ChannelInfo[]>([]);
let newName = $state("");
let error = $state("");
let loading = $state(true);
let joining = $state<string | null>(null);

function loadChannels() {
  loading = true;
  fetchChannels()
    .then((c) => {
      channels = c;
      error = "";
    })
    .catch((err) => {
      error = err instanceof Error ? err.message : "Failed to load channels";
    })
    .finally(() => {
      loading = false;
    });
}

onMount(() => {
  loadChannels();
});

async function handleCreate() {
  const name = newName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!name) return;

  try {
    const conv = await createVoluteChannel(name);
    newName = "";
    loadChannels();
    onJoined(conv);
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to create channel";
  }
}

async function handleJoin(ch: ChannelInfo) {
  if (!ch.name) return;
  joining = ch.name;
  try {
    await joinVoluteChannel(ch.name);
    onJoined(ch);
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to join channel";
  } finally {
    joining = null;
  }
}

async function handleLeave(ch: ChannelInfo) {
  if (!ch.name) return;
  try {
    await leaveVoluteChannel(ch.name);
    loadChannels();
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to leave channel";
  }
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape") onClose();
  if (e.key === "Enter") handleCreate();
}
</script>

<Modal size="380px" title="Browse channels" {onClose}>
  {#if error}
    <div class="error">{error}</div>
  {/if}

  <div class="channel-list">
    {#if loading}
      <div class="empty">Loading...</div>
    {:else if channels.length === 0}
      <div class="empty">No channels yet. Create one below.</div>
    {:else}
      {#each channels as ch (ch.id)}
        <div class="channel-row">
          <div class="channel-info">
            <span class="channel-name">#{ch.name}</span>
            <span class="channel-meta">{ch.participantCount} member{ch.participantCount === 1 ? "" : "s"}</span>
          </div>
          <button
            class="action-btn"
            class:leave={ch.isMember}
            onclick={() => ch.isMember ? handleLeave(ch) : handleJoin(ch)}
            disabled={joining === ch.name}
          >
            {joining === ch.name ? "..." : ch.isMember ? "leave" : "join"}
          </button>
        </div>
      {/each}
    {/if}
  </div>

  <div class="create-section">
    <input
      type="text"
      bind:value={newName}
      placeholder="new-channel-name"
      class="name-input"
      onkeydown={handleKeyDown}
    />
    <button class="create-btn" onclick={handleCreate} disabled={!newName.trim()}>Create</button>
  </div>
</Modal>

<style>
  .error {
    padding: 8px 16px;
    font-size: 12px;
    color: var(--red);
  }

  .channel-list {
    flex: 1;
    overflow: auto;
    padding: 8px;
  }

  .empty {
    color: var(--text-2);
    font-size: 12px;
    text-align: center;
    padding: 20px;
  }

  .channel-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px;
    border-radius: var(--radius);
  }

  .channel-row:hover {
    background: var(--bg-2);
  }

  .channel-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .channel-name {
    font-size: 13px;
    color: var(--text-0);
    font-weight: 500;
  }

  .channel-meta {
    font-size: 11px;
    color: var(--text-2);
  }

  .action-btn {
    padding: 4px 12px;
    font-size: 11px;
    border-radius: var(--radius);
    background: var(--accent-dim);
    color: var(--accent);
    font-weight: 500;
  }

  .action-btn.leave {
    background: var(--bg-3);
    color: var(--text-2);
  }

  .create-section {
    display: flex;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
  }

  .name-input {
    flex: 1;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px 10px;
    color: var(--text-0);
    font-size: 12px;
    font-family: var(--mono);
    outline: none;
  }

  .name-input:focus {
    border-color: var(--border-bright);
  }

  .create-btn {
    padding: 8px 14px;
    background: var(--accent-dim);
    color: var(--accent);
    border-radius: var(--radius);
    font-size: 12px;
    font-weight: 500;
  }

  .create-btn:disabled {
    opacity: 0.4;
  }
</style>
