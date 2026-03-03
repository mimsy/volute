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
} from "../lib/auth";
import { deleteMind } from "../lib/client";
import { mindDotColor } from "../lib/format";
import { activeMinds, data, onlineBrains } from "../lib/stores.svelte";

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

let brainUsers = $derived(users.filter((u) => u.user_type !== "mind"));
let mindUsers = $derived(users.filter((u) => u.user_type === "mind"));
let adminCount = $derived(users.filter((u) => u.role === "admin").length);

function refresh() {
  fetchUsers()
    .then((u) => {
      users = u;
      error = "";
    })
    .catch(() => {
      error = "Failed to load users";
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

async function handleDeleteBrain(user: AuthUser) {
  deletingId = user.id;
  try {
    await deleteUser(user.id);
    expandedId = null;
    confirmingDeleteId = null;
    refresh();
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to delete user";
  } finally {
    deletingId = null;
  }
}

async function handleDeleteMind(user: AuthUser) {
  deletingId = user.id;
  try {
    try {
      await deleteMind(user.username, true);
      data.minds = data.minds.filter((m) => m.name !== user.username);
    } catch {
      // Mind may already be gone from registry — just delete the account
      await deleteUser(user.id);
    }
    expandedId = null;
    confirmingDeleteId = null;
    refresh();
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to delete mind";
  } finally {
    deletingId = null;
  }
}

function isProfileDirty(user: AuthUser): boolean {
  return (
    (editDisplayName.trim() || null) !== (user.display_name ?? null) ||
    (editDescription.trim() || null) !== (user.description ?? null)
  );
}
</script>

<div class="container">
  {#if brainUsers.length > 0}
    <div class="section-title">Brains</div>
    <div class="user-list">
      {#each brainUsers as u (u.id)}
        <div class="user-card" class:expanded={expandedId === u.id}>
          <div class="user-row" role="button" tabindex="0" onclick={() => toggleExpand(u)} onkeydown={(e) => e.key === 'Enter' && toggleExpand(u)}>
            <span
              class="status-dot"
              style:background={onlineBrains.has(u.username) ? "var(--text-0)" : "var(--text-2)"}
            ></span>
            <div class="user-info">
              <span class="display-name">{u.display_name || u.username}</span>
              {#if u.display_name}
                <span class="username">@{u.username}</span>
              {/if}
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
                  {:else if u.role === "user"}
                    <button class="action-btn" onclick={(e) => handleToggleAdmin(e, u)}>make admin</button>
                  {/if}
                  {#if confirmingDeleteId === u.id}
                    <span class="confirm-prompt">
                      delete account?
                      <button
                        class="confirm-yes"
                        disabled={deletingId === u.id}
                        onclick={() => handleDeleteBrain(u)}
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
  {/if}

  {#if mindUsers.length > 0}
    <div class="section-title">Minds</div>
    <div class="user-list">
      {#each mindUsers as u (u.id)}
        {@const mind = mindsByName.get(u.username)}
        <div class="user-card" class:expanded={expandedId === u.id}>
          <div class="user-row" role="button" tabindex="0" onclick={() => toggleExpand(u)} onkeydown={(e) => e.key === 'Enter' && toggleExpand(u)}>
            <span
              class="status-dot"
              class:iridescent={activeMinds.has(u.username)}
              style:background={activeMinds.has(u.username) ? undefined : (mind ? mindDotColor(mind) : "var(--text-2)")}
            ></span>
            <div class="user-info">
              <span class="display-name">{u.display_name || u.username}</span>
              {#if u.display_name}
                <span class="username">@{u.username}</span>
              {/if}
            </div>
            <div class="row-actions">
              {#if u.role === "admin"}
                <span class="role admin">admin</span>
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
                  {:else}
                    <button class="action-btn" onclick={(e) => handleToggleAdmin(e, u)}>make admin</button>
                  {/if}
                  {#if confirmingDeleteId === u.id}
                    <span class="confirm-prompt">
                      delete mind + data?
                      <button
                        class="confirm-yes"
                        disabled={deletingId === u.id}
                        onclick={() => handleDeleteMind(u)}
                      >{deletingId === u.id ? "..." : "yes"}</button>
                      <button class="confirm-no" onclick={() => (confirmingDeleteId = null)}>no</button>
                    </span>
                  {:else}
                    <button
                      class="action-btn danger"
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
  {/if}

  {#if users.length === 0}
    <div class="empty">No users yet.</div>
  {/if}
</div>

<style>
  .container {
    max-width: 600px;
    animation: fadeIn 0.2s ease both;
  }

  .section-title {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-2);
    padding: 12px 0 6px;
  }

  .section-title:first-child {
    padding-top: 0;
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
    align-items: baseline;
    gap: 6px;
  }

  .display-name {
    font-weight: 500;
    color: var(--text-0);
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .username {
    font-size: 11px;
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
    font-size: 10px;
    transition: transform 0.15s;
    display: inline-block;
  }

  .expand-icon.open {
    transform: rotate(90deg);
  }

  .role {
    font-size: 11px;
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
    font-size: 11px;
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
    font-size: 10px;
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
    font-size: 12px;
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
    font-size: 11px;
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
    font-size: 11px;
    color: var(--red);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .confirm-yes {
    padding: 2px 8px;
    background: var(--red-bg);
    color: var(--red);
    font-size: 11px;
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
    font-size: 11px;
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
    font-size: 11px;
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
    font-size: 11px;
  }

  .empty {
    color: var(--text-2);
    text-align: center;
    padding: 24px;
  }
</style>
