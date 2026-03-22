<script lang="ts">
import type { Mind } from "@volute/api";
import { onMount } from "svelte";
import { slide } from "svelte/transition";
import {
  type AuthUser,
  approveUser,
  deleteUser,
  fetchUsers,
  setUserRole,
  updateUserProfile,
} from "../../lib/auth";
import { deleteMind } from "../../lib/client";
import { mindDotColor } from "../../lib/format";
import { activeMinds, data, onlineBrains } from "../../lib/stores.svelte";

let { minds }: { minds: Mind[] } = $props();

let users = $state<AuthUser[]>([]);
let error = $state("");
let expandedId = $state<number | null>(null);

// Edit state
let editDisplayName = $state("");
let editDescription = $state("");
let saving = $state(false);

// Delete confirmation
let confirmingDeleteId = $state<number | null>(null);
let deletingId = $state<number | null>(null);

let mindsByName = $derived(new Map(minds.map((m) => [m.name, m])));
let adminCount = $derived(users.filter((u) => u.role === "admin").length);

function refresh() {
  fetchUsers()
    .then((u) => {
      users = u;
    })
    .catch(() => {
      if (!error) error = "Failed to load users";
    });
}

onMount(() => {
  refresh();
});

function toggleExpand(user: AuthUser) {
  error = "";
  if (expandedId === user.id) {
    expandedId = null;
    confirmingDeleteId = null;
  } else {
    expandedId = user.id;
    editDisplayName = user.display_name ?? "";
    editDescription = user.description ?? "";
    confirmingDeleteId = null;
  }
}

function statusDotStyle(u: AuthUser): string | undefined {
  if (u.user_type === "mind") {
    if (activeMinds.has(u.username)) return undefined; // iridescent handles it
    const mind = mindsByName.get(u.username);
    return mind ? mindDotColor(mind) : "var(--text-2)";
  }
  return onlineBrains.has(u.username) ? "var(--text-0)" : "var(--text-2)";
}

async function handleApprove(e: Event, id: number) {
  e.stopPropagation();
  try {
    await approveUser(id);
    refresh();
  } catch {
    error = "Failed to approve user";
  }
}

async function handleToggleAdmin(e: Event, user: AuthUser) {
  e.stopPropagation();
  const newRole = user.role === "admin" ? "user" : "admin";
  try {
    await setUserRole(user.id, newRole);
    refresh();
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to change role";
  }
}

async function handleSaveProfile(user: AuthUser) {
  saving = true;
  try {
    await updateUserProfile(user.id, {
      display_name: editDisplayName.trim() || null,
      description: editDescription.trim() || null,
    });
    refresh();
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to update profile";
  } finally {
    saving = false;
  }
}

async function handleDelete(user: AuthUser) {
  deletingId = user.id;
  try {
    if (user.user_type === "mind") {
      try {
        await deleteMind(user.username, true);
        data.minds = data.minds.filter((m) => m.name !== user.username);
      } catch (mindErr) {
        if (mindErr instanceof Error && mindErr.message.includes("not found")) {
          await deleteUser(user.id);
        } else {
          throw mindErr;
        }
      }
    } else {
      await deleteUser(user.id);
    }
    expandedId = null;
    confirmingDeleteId = null;
    refresh();
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to delete";
  } finally {
    deletingId = null;
  }
}

function deleteLabel(user: AuthUser): string {
  return user.user_type === "mind" ? "delete mind + data?" : "delete account?";
}

function isProfileDirty(user: AuthUser): boolean {
  return (
    (editDisplayName.trim() || null) !== (user.display_name ?? null) ||
    (editDescription.trim() || null) !== (user.description ?? null)
  );
}
</script>

<div class="container">
  <div class="user-list">
    {#each users as u (u.id)}
      <div class="user-card" class:expanded={expandedId === u.id}>
        <div class="user-row" role="button" tabindex="0" onclick={() => toggleExpand(u)} onkeydown={(e) => e.key === 'Enter' && toggleExpand(u)}>
          <span
            class="status-dot"
            class:iridescent={u.user_type === "mind" && activeMinds.has(u.username)}
            style:background={statusDotStyle(u)}
          ></span>
          <div class="user-info">
            <span class="display-name">{u.display_name || u.username}</span>
            {#if u.display_name}
              <span class="username">@{u.username}</span>
            {/if}
            <svg class="type-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              {#if u.user_type === "mind"}
                <rect x="4" y="8" width="16" height="12" rx="2" />
                <circle cx="9" cy="14" r="1.5" />
                <circle cx="15" cy="14" r="1.5" />
                <line x1="12" y1="4" x2="12" y2="8" />
                <circle cx="12" cy="3" r="1" />
              {:else}
                <path d="M5 11a7 7 0 1 1 14 0c0 3-1.5 5-3 6v3H8v-3c-1.5-1-3-3-3-6z" />
                <path d="M5 10c-.6 0-1 .8-1 1.8S4.4 13.5 5 13.5" />
                <path d="M19 10c.6 0 1 .8 1 1.8s-.4 1.7-1 1.7" />
                <circle cx="9.5" cy="10.5" r="1" fill="currentColor" stroke="none" />
                <circle cx="14.5" cy="10.5" r="1" fill="currentColor" stroke="none" />
              {/if}
            </svg>
          </div>
          <div class="row-actions">
            {#if u.role === "admin"}
              <span class="role admin">admin</span>
            {/if}
            {#if u.role === "pending"}
              <span class="role pending">pending</span>
              <button class="approve-btn" onclick={(e) => handleApprove(e, u.id)}>approve</button>
            {/if}
            <span class="expand-icon" class:open={expandedId === u.id}>&#x25B8;</span>
          </div>
        </div>

        {#if expandedId === u.id}
          <div class="detail-panel" transition:slide={{ duration: 150 }}>
            <div class="field">
              <label for="dn-{u.id}">Display name</label>
              <input
                id="dn-{u.id}"
                type="text"
                bind:value={editDisplayName}
                placeholder={u.username}
              />
            </div>
            <div class="field">
              <label for="desc-{u.id}">Description</label>
              <input
                id="desc-{u.id}"
                type="text"
                bind:value={editDescription}
                placeholder="Optional description"
              />
            </div>
            {#if error}
              <div class="error">{error}</div>
            {/if}
            <div class="detail-actions">
              <div class="left-actions">
                {#if u.role === "admin"}
                  <button
                    class="action-btn"
                    disabled={adminCount <= 1}
                    onclick={(e) => handleToggleAdmin(e, u)}
                  >remove admin</button>
                {:else if u.role !== "pending"}
                  <button class="action-btn" onclick={(e) => handleToggleAdmin(e, u)}>make admin</button>
                {/if}
                {#if confirmingDeleteId === u.id}
                  <span class="confirm-prompt">
                    {deleteLabel(u)}
                    <button
                      class="confirm-yes"
                      disabled={deletingId === u.id}
                      onclick={() => handleDelete(u)}
                    >{deletingId === u.id ? "..." : "yes"}</button>
                    <button class="confirm-no" onclick={() => (confirmingDeleteId = null)}>no</button>
                  </span>
                {:else}
                  <button
                    class="action-btn danger"
                    disabled={u.role === "admin" && adminCount <= 1}
                    onclick={() => (confirmingDeleteId = u.id)}
                  >delete</button>
                {/if}
              </div>
              <button
                class="save-btn"
                disabled={!isProfileDirty(u) || saving}
                onclick={() => handleSaveProfile(u)}
              >{saving ? "saving..." : "save"}</button>
            </div>
          </div>
        {/if}
      </div>
    {/each}
  </div>

  {#if users.length === 0}
    <div class="empty">No users yet.</div>
  {/if}
</div>

<style>
  .container {
    max-width: 600px;
    animation: fadeIn 0.2s ease both;
  }

  .user-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .user-card {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    transition: border-color 0.15s;
  }

  .user-card:hover,
  .user-card.expanded {
    border-color: var(--border-bright);
  }

  .user-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    width: 100%;
    background: none;
    cursor: pointer;
    text-align: left;
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

  @keyframes iridescent {
    0%   { background: #4ade80; }
    16%  { background: #60a5fa; }
    33%  { background: #c084fc; }
    50%  { background: #f472b6; }
    66%  { background: #fbbf24; }
    83%  { background: #34d399; }
    100% { background: #4ade80; }
  }

  .user-info {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .display-name {
    font-weight: 500;
    color: var(--text-0);
    font-size: 14px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .username {
    font-size: 12px;
    color: var(--text-2);
    flex-shrink: 0;
  }

  .type-icon {
    width: 13px;
    height: 13px;
    color: var(--text-2);
    flex-shrink: 0;
  }

  .row-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .expand-icon {
    color: var(--text-2);
    font-size: 11px;
    transition: transform 0.15s;
    display: inline-block;
  }

  .expand-icon.open {
    transform: rotate(90deg);
  }

  .role {
    font-size: 12px;
    color: var(--text-2);
  }

  .role.admin {
    color: var(--accent);
  }

  .role.pending {
    color: var(--yellow);
  }

  .approve-btn {
    padding: 4px 12px;
    background: var(--accent-dim);
    color: var(--accent);
    border-radius: var(--radius);
    font-size: 12px;
    font-weight: 500;
  }

  .detail-panel {
    padding: 0 14px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    border-top: 1px solid var(--border);
    margin-top: 0;
    padding-top: 12px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .field label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-2);
  }

  .field input {
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 6px 10px;
    color: var(--text-0);
    font-size: 13px;
    font-family: inherit;
  }

  .field input:focus {
    outline: none;
    border-color: var(--border-bright);
  }

  .field input::placeholder {
    color: var(--text-2);
  }

  .detail-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 4px;
  }

  .left-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .action-btn {
    padding: 4px 8px;
    background: none;
    color: var(--text-2);
    font-size: 12px;
    border-radius: var(--radius);
  }

  .action-btn:hover:not(:disabled) {
    color: var(--text-0);
    background: var(--bg-3);
  }

  .action-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .action-btn.danger {
    color: var(--red);
  }

  .action-btn.danger:hover:not(:disabled) {
    background: var(--red-bg);
    color: var(--red);
  }

  .confirm-prompt {
    font-size: 12px;
    color: var(--red);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .confirm-yes {
    padding: 2px 8px;
    background: var(--red-bg);
    color: var(--red);
    font-size: 12px;
    border-radius: var(--radius);
    font-weight: 500;
  }

  .confirm-yes:hover:not(:disabled) {
    background: var(--red);
    color: var(--bg-0);
  }

  .confirm-no {
    padding: 2px 8px;
    background: none;
    color: var(--text-2);
    font-size: 12px;
    border-radius: var(--radius);
  }

  .confirm-no:hover {
    color: var(--text-0);
    background: var(--bg-3);
  }

  .save-btn {
    padding: 4px 12px;
    background: var(--accent-dim);
    color: var(--accent);
    border-radius: var(--radius);
    font-size: 12px;
    font-weight: 500;
  }

  .save-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .save-btn:hover:not(:disabled) {
    background: var(--accent);
    color: var(--bg-0);
  }

  .error {
    color: var(--red);
    font-size: 12px;
  }

  .empty {
    color: var(--text-2);
    text-align: center;
    padding: 24px;
  }
</style>
