<script lang="ts">
import type { Mind } from "../lib/api";

let {
  minds,
  username,
  systemName,
  connectionOk = true,
  isAdmin,
  onAdminClick,
  onRestart,
  onLogout,
  onUserSettings,
}: {
  minds: Mind[];
  username: string;
  systemName: string | null;
  connectionOk?: boolean;
  isAdmin: boolean;
  onAdminClick: () => void;
  onRestart: () => void;
  onLogout: () => void;
  onUserSettings: () => void;
} = $props();

let runningCount = $derived(minds.filter((m) => m.status === "running").length);

let showSystemMenu = $state(false);
let showUserMenu = $state(false);

function toggleSystemMenu() {
  showSystemMenu = !showSystemMenu;
  showUserMenu = false;
}

function toggleUserMenu() {
  showUserMenu = !showUserMenu;
  showSystemMenu = false;
}

function handleClickOutside(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (!target.closest(".menu-anchor")) {
    showSystemMenu = false;
    showUserMenu = false;
  }
}
</script>

<svelte:document onclick={handleClickOutside} />

<div class="status-bar">
  <div class="status-left">
    <div class="menu-anchor">
      <button class="status-btn" onclick={toggleSystemMenu}>
        <span class="dot" class:disconnected={!connectionOk}></span>
        {#if systemName}
          {systemName}
        {:else}
          daemon
        {/if}
      </button>
      {#if showSystemMenu}
        <div class="dropdown">
          <button
            class="dropdown-item"
            onclick={() => {
              showSystemMenu = false;
              onRestart();
            }}
          >
            Restart
          </button>
          {#if isAdmin}
            <button
              class="dropdown-item"
              onclick={() => {
                showSystemMenu = false;
                onAdminClick();
              }}
            >
              Settings
            </button>
          {/if}
        </div>
      {/if}
    </div>
    <span class="sep">|</span>
    <span class="mind-count">{runningCount}/{minds.length} minds</span>
  </div>
  <div class="status-right">
    <div class="menu-anchor">
      <button class="status-btn username-btn" onclick={toggleUserMenu}>
        {username}
      </button>
      {#if showUserMenu}
        <div class="dropdown right">
          <button
            class="dropdown-item"
            onclick={() => {
              showUserMenu = false;
              onUserSettings();
            }}
          >
            User Settings
          </button>
          <button
            class="dropdown-item"
            onclick={() => {
              showUserMenu = false;
              onLogout();
            }}
          >
            Logout
          </button>
        </div>
      {/if}
    </div>
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

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    display: inline-block;
    flex-shrink: 0;
  }

  .dot.disconnected {
    background: var(--red);
  }

  .sep {
    color: var(--border);
  }

  .menu-anchor {
    position: relative;
  }

  .status-btn {
    background: none;
    color: var(--text-2);
    font-size: 11px;
    padding: 2px 4px;
    display: flex;
    align-items: center;
    gap: 5px;
    border-radius: 3px;
  }

  .status-btn:hover {
    color: var(--text-0);
    background: var(--bg-2);
  }

  .username-btn {
    color: var(--text-1);
  }

  .dropdown {
    position: absolute;
    bottom: calc(100% + 4px);
    left: 0;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    min-width: 120px;
    padding: 4px 0;
    z-index: 100;
    box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.3);
  }

  .dropdown.right {
    left: auto;
    right: 0;
  }

  .dropdown-item {
    display: block;
    width: 100%;
    text-align: left;
    padding: 6px 12px;
    background: none;
    color: var(--text-1);
    font-size: 11px;
    white-space: nowrap;
  }

  .dropdown-item:hover {
    background: var(--bg-3);
    color: var(--text-0);
  }
</style>
