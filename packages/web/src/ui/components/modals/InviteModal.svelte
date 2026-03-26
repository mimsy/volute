<script lang="ts">
import type { AvailableUser, Mind } from "@volute/api";
import { Modal } from "@volute/ui";
import { fetchAvailableUsers, inviteToChannel } from "../../lib/client";
import { mindDotColor } from "../../lib/format";
import { activeMinds, connectActivity, onlineBrains } from "../../lib/stores.svelte";

let {
  channelName,
  minds,
  onClose,
}: {
  channelName: string;
  minds: Mind[];
  onClose: () => void;
} = $props();

let query = $state("");
let error = $state("");
let inviting = $state(false);
let allUsers = $state<AvailableUser[]>([]);
let memberNames = $state(new Set<string>());

let mindsByName = $derived(new Map(minds.map((m) => [m.name, m])));

let suggestions = $derived.by(() => {
  const nonMembers = allUsers.filter((u) => !memberNames.has(u.username));
  if (!query.trim()) return nonMembers;
  const q = query.toLowerCase();
  return nonMembers.filter(
    (u) => u.username.toLowerCase().includes(q) || u.display_name?.toLowerCase().includes(q),
  );
});

async function load() {
  try {
    allUsers = await fetchAvailableUsers();
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load users";
  }
}

load();

async function handleInvite(username: string) {
  if (inviting) return;
  inviting = true;
  error = "";
  try {
    await inviteToChannel(channelName, username);
    memberNames = new Set([...memberNames, username]);
    query = "";
    connectActivity();
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to invite";
  } finally {
    inviting = false;
  }
}

function dotColor(user: AvailableUser): string | undefined {
  if (user.user_type === "mind") {
    const mind = mindsByName.get(user.username);
    if (mind && activeMinds.has(mind.name)) return undefined;
    if (mind) return mindDotColor(mind);
    return "var(--text-2)";
  }
  if (onlineBrains.has(user.username)) return "var(--text-0)";
  return "var(--text-2)";
}

function isIridescent(user: AvailableUser): boolean {
  return user.user_type === "mind" && activeMinds.has(user.username);
}
</script>

<Modal size="380px" title="Invite to #{channelName}" {onClose}>
  <div class="invite-body">
    <input
      type="text"
      bind:value={query}
      placeholder="Search users..."
      class="search-input"
    />
    {#if error}
      <div class="error">{error}</div>
    {/if}
    <div class="user-list">
      {#each suggestions as user}
        <button class="user-row" onclick={() => handleInvite(user.username)} disabled={inviting}>
          <span
            class="status-dot"
            class:iridescent={isIridescent(user)}
            style:background={isIridescent(user) ? undefined : dotColor(user)}
          ></span>
          <span class="user-name">{user.display_name ?? user.username}</span>
          {#if user.display_name && user.display_name !== user.username}
            <span class="user-username">@{user.username}</span>
          {/if}
        </button>
      {:else}
        <div class="empty">{allUsers.length === 0 ? "Loading..." : "No users to invite"}</div>
      {/each}
    </div>
  </div>
</Modal>

<style>
  .invite-body {
    padding: 12px 16px 16px;
  }

  .search-input {
    width: 100%;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px 10px;
    color: var(--text-0);
    font-size: 14px;
    outline: none;
    box-sizing: border-box;
  }

  .search-input:focus {
    border-color: var(--border-bright);
  }

  .error {
    color: var(--red);
    font-size: 13px;
    padding: 6px 0 0;
  }

  .user-list {
    max-height: 280px;
    overflow: auto;
    margin-top: 8px;
  }

  .user-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 8px;
    width: 100%;
    background: none;
    text-align: left;
    font-size: 14px;
    color: var(--text-1);
    cursor: pointer;
    border-radius: var(--radius);
  }

  .user-row:hover:not(:disabled) {
    background: var(--bg-2);
  }

  .user-row:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .user-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
    color: var(--text-0);
  }

  .user-username {
    font-size: 12px;
    color: var(--text-2);
    margin-left: auto;
    flex-shrink: 0;
  }

  .status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .status-dot.iridescent {
    animation: iridescent 3s ease-in-out infinite;
  }
  .empty {
    color: var(--text-2);
    font-size: 13px;
    padding: 12px 8px;
    text-align: center;
  }
</style>
