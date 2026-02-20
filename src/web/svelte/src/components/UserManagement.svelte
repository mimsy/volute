<script lang="ts">
import { type AuthUser, approveUser, fetchUsers } from "../lib/auth";

let { onClose }: { onClose: () => void } = $props();

let users = $state<AuthUser[]>([]);

function refresh() {
  fetchUsers()
    .then((u) => {
      users = u;
    })
    .catch(() => {});
}

$effect(() => {
  refresh();
});

async function handleApprove(id: number) {
  await approveUser(id);
  refresh();
}
</script>

<div class="container">
  <div class="header">
    <h2 class="title">Users</h2>
    <button class="back-btn" onclick={onClose}>back</button>
  </div>

  <div class="user-list">
    {#each users as u}
      <div class="user-row">
        <div>
          <span class="username">{u.username}</span>
          <span class="role" class:admin={u.role === "admin"} class:pending={u.role === "pending"}>
            {u.role}
          </span>
        </div>
        {#if u.role === "pending"}
          <button class="approve-btn" onclick={() => handleApprove(u.id)}>approve</button>
        {/if}
      </div>
    {/each}
    {#if users.length === 0}
      <div class="empty">No users yet.</div>
    {/if}
  </div>
</div>

<style>
  .container {
    max-width: 600px;
    animation: fadeIn 0.2s ease both;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }

  .title {
    font-size: 15px;
    font-weight: 600;
  }

  .back-btn {
    background: transparent;
    color: var(--text-2);
    font-size: 12px;
  }

  .user-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .user-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .username {
    color: var(--text-0);
    margin-right: 12px;
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

  .empty {
    color: var(--text-2);
    text-align: center;
    padding: 24px;
  }
</style>
