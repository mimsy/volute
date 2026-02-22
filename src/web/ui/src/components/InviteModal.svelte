<script lang="ts">
import { onMount } from "svelte";
import {
  type AvailableUser,
  fetchAvailableUsers,
  fetchChannelMembers,
  inviteToChannel,
  type Participant,
} from "../lib/api";
import Modal from "./Modal.svelte";

let {
  channelName,
  onClose,
}: {
  channelName: string;
  onClose: () => void;
} = $props();

let users = $state<AvailableUser[]>([]);
let members = $state<Participant[]>([]);
let search = $state("");
let loading = $state(true);
let error = $state("");
let inviting = $state<string | null>(null);

let filtered = $derived.by(() => {
  const memberIds = new Set(members.map((m) => m.userId));
  const available = users.filter((u) => !memberIds.has(u.id));
  if (!search.trim()) return available;
  const q = search.toLowerCase();
  return available.filter((u) => u.username.toLowerCase().includes(q));
});

onMount(() => {
  Promise.all([fetchAvailableUsers(), fetchChannelMembers(channelName)])
    .then(([u, m]) => {
      users = u;
      members = m;
      error = "";
    })
    .catch((err) => {
      error = err instanceof Error ? err.message : "Failed to load";
    })
    .finally(() => {
      loading = false;
    });
});

async function handleInvite(user: AvailableUser) {
  inviting = user.username;
  try {
    await inviteToChannel(channelName, user.username);
    members = [
      ...members,
      { userId: user.id, username: user.username, userType: user.user_type, role: "member" },
    ];
    error = "";
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to invite";
  } finally {
    inviting = null;
  }
}
</script>

<Modal size="380px" title="Invite to #{channelName}" {onClose}>
  {#if error}
    <div class="error">{error}</div>
  {/if}

  <div class="search-section">
    <input
      type="text"
      bind:value={search}
      placeholder="Search users..."
      class="search-input"
    />
  </div>

  <div class="user-list">
    {#if loading}
      <div class="empty">Loading...</div>
    {:else if filtered.length === 0}
      <div class="empty">No users to invite.</div>
    {:else}
      {#each filtered as user (user.id)}
        <div class="user-row">
          <div class="user-info">
            <span class="username">{user.username}</span>
            <span class="user-type">{user.user_type}</span>
          </div>
          <button
            class="invite-btn"
            onclick={() => handleInvite(user)}
            disabled={inviting === user.username}
          >
            {inviting === user.username ? "..." : "invite"}
          </button>
        </div>
      {/each}
    {/if}
  </div>
</Modal>

<style>
  .error {
    padding: 8px 16px;
    font-size: 12px;
    color: var(--red);
  }

  .search-section {
    padding: 8px 16px;
  }

  .search-input {
    width: 100%;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px 10px;
    color: var(--text-0);
    font-size: 12px;
    font-family: var(--mono);
    outline: none;
    box-sizing: border-box;
  }

  .search-input:focus {
    border-color: var(--border-bright);
  }

  .user-list {
    flex: 1;
    overflow: auto;
    padding: 8px;
    max-height: 300px;
  }

  .empty {
    color: var(--text-2);
    font-size: 12px;
    text-align: center;
    padding: 20px;
  }

  .user-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px;
    border-radius: var(--radius);
  }

  .user-row:hover {
    background: var(--bg-2);
  }

  .user-info {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .username {
    font-size: 13px;
    color: var(--text-0);
    font-weight: 500;
  }

  .user-type {
    font-size: 11px;
    color: var(--text-2);
  }

  .invite-btn {
    padding: 4px 12px;
    font-size: 11px;
    border-radius: var(--radius);
    background: var(--accent-dim);
    color: var(--accent);
    font-weight: 500;
  }

  .invite-btn:disabled {
    opacity: 0.4;
  }
</style>
