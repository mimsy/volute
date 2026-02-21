<script lang="ts">
import type { Mind } from "../lib/api";

let {
  minds,
  username,
  systemName,
  connectionOk = true,
  isAdmin,
  onAdminClick,
  onLogout,
}: {
  minds: Mind[];
  username: string;
  systemName: string | null;
  connectionOk?: boolean;
  isAdmin: boolean;
  onAdminClick: () => void;
  onLogout: () => void;
} = $props();

let runningCount = $derived(minds.filter((m) => m.status === "running").length);
</script>

<div class="status-bar">
  <div class="status-left">
    <span class="daemon-status">
      <span class="dot" class:disconnected={!connectionOk}></span>
      {#if systemName}
        {systemName}
      {:else}
        daemon
      {/if}
    </span>
    <span class="sep">|</span>
    <span class="mind-count">{runningCount}/{minds.length} minds</span>
  </div>
  <div class="status-right">
    <span class="username">{username}</span>
    {#if isAdmin}
      <button class="admin-btn" onclick={onAdminClick} title="Admin settings">&#9881;</button>
    {/if}
    <button class="logout-btn" onclick={onLogout}>logout</button>
  </div>
</div>

<style>
  .status-bar {
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 12px;
    background: var(--bg-1);
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--text-2);
    flex-shrink: 0;
  }

  .status-left,
  .status-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .daemon-status {
    display: flex;
    align-items: center;
    gap: 5px;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
  }

  .dot.disconnected {
    background: var(--red);
  }

  .sep {
    color: var(--border);
  }

  .username {
    color: var(--text-1);
  }

  .admin-btn {
    background: none;
    color: var(--text-2);
    font-size: 13px;
    padding: 0 2px;
    line-height: 1;
  }

  .admin-btn:hover {
    color: var(--text-0);
  }

  .logout-btn {
    background: none;
    color: var(--text-2);
    font-size: 10px;
    padding: 0;
  }

  .logout-btn:hover {
    color: var(--text-1);
  }
</style>
