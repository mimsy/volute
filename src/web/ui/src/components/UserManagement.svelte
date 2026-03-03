<script lang="ts">
import type { Mind } from "@volute/api";
import { onMount } from "svelte";
import { type AuthUser, approveUser, fetchUsers, setUserRole } from "../lib/auth";
import { mindDotColor } from "../lib/format";
import { activeMinds, onlineBrains } from "../lib/stores.svelte";

let { minds }: { minds: Mind[] } = $props();

let users = $state<AuthUser[]>([]);
let error = $state("");

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

async function handleApprove(id: number) {
  try {
    await approveUser(id);
    refresh();
  } catch {
    error = "Failed to approve user";
  }
}

async function handleToggleAdmin(user: AuthUser) {
  const newRole = user.role === "admin" ? "user" : "admin";
  try {
    await setUserRole(user.id, newRole);
    refresh();
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to change role";
  }
}
</script>

<div class="container">
  {#if error}
    <div class="error">{error}</div>
  {/if}

  {#if brainUsers.length > 0}
    <div class="section-title">Brains</div>
    <div class="user-list">
      {#each brainUsers as u (u.id)}
        <div class="user-row">
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
          <div class="actions">
            {#if u.role === "admin"}
              <span class="role admin">admin</span>
            {/if}
            {#if u.role === "pending"}
              <span class="role pending">pending</span>
              <button class="approve-btn" onclick={() => handleApprove(u.id)}>approve</button>
            {:else if u.role === "admin"}
              <button
                class="admin-toggle"
                disabled={adminCount <= 1}
                onclick={() => handleToggleAdmin(u)}
              >remove admin</button>
            {:else if u.role === "user"}
              <button class="admin-toggle" onclick={() => handleToggleAdmin(u)}>make admin</button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}

  {#if mindUsers.length > 0}
    <div class="section-title">Minds</div>
    <div class="user-list">
      {#each mindUsers as u (u.id)}
        {@const mind = mindsByName.get(u.username)}
        <div class="user-row">
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
          <div class="actions">
            {#if u.role === "admin"}
              <span class="role admin">admin</span>
              <button
                class="admin-toggle"
                disabled={adminCount <= 1}
                onclick={() => handleToggleAdmin(u)}
              >remove admin</button>
            {/if}
          </div>
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

  .user-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
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

  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
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

  .admin-toggle {
    padding: 4px 8px;
    background: none;
    color: var(--text-2);
    font-size: 11px;
    border-radius: var(--radius);
  }

  .admin-toggle:hover:not(:disabled) {
    color: var(--text-0);
    background: var(--bg-3);
  }

  .admin-toggle:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .error {
    color: var(--red);
    font-size: 12px;
    margin-bottom: 12px;
  }

  .empty {
    color: var(--text-2);
    text-align: center;
    padding: 24px;
  }
</style>
