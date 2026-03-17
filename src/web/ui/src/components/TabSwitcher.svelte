<script lang="ts">
import type { Tab } from "../lib/navigate";

let {
  activeTab,
  onSwitch,
  chatUnreadCount = 0,
}: {
  activeTab: Tab;
  onSwitch: (tab: Tab) => void;
  chatUnreadCount?: number;
} = $props();
</script>

<div class="tab-switcher">
  <button
    class="tab-btn"
    class:active={activeTab === "system"}
    onclick={() => onSwitch("system")}
  >
    System
  </button>
  <button
    class="tab-btn"
    class:active={activeTab === "chat"}
    onclick={() => onSwitch("chat")}
  >
    Chat
    {#if chatUnreadCount > 0}
      <span class="unread-badge">{chatUnreadCount > 99 ? "99+" : chatUnreadCount}</span>
    {/if}
  </button>
</div>

<style>
  .tab-switcher {
    display: flex;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    background: var(--bg-1);
  }

  .tab-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 8px 0;
    background: none;
    color: var(--text-2);
    font-family: var(--display);
    font-size: 14px;
    font-weight: 400;
    letter-spacing: 0.03em;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }

  .tab-btn:hover {
    color: var(--text-1);
  }

  .tab-btn.active {
    color: var(--text-0);
    border-bottom-color: var(--accent);
  }

  .unread-badge {
    font-size: 10px;
    font-weight: 600;
    font-family: var(--sans);
    background: var(--accent);
    color: var(--bg-0);
    padding: 1px 5px;
    border-radius: 8px;
    line-height: 1.2;
  }
</style>
