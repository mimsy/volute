<script lang="ts">
import Settings from "../pages/Settings.svelte";
import SystemLogs from "./SystemLogs.svelte";
import UserManagement from "./UserManagement.svelte";

let { onClose }: { onClose: () => void } = $props();

const TABS = ["Settings", "System Logs", "Users"] as const;
type Tab = (typeof TABS)[number];

let tab = $state<Tab>("Settings");
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-overlay" onclick={onClose} onkeydown={() => {}}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
    <div class="modal-header">
      <div class="tab-bar">
        {#each TABS as t}
          <button class="tab" class:active={t === tab} onclick={() => (tab = t)}>{t}</button>
        {/each}
      </div>
      <button class="close-btn" onclick={onClose}>&#x2715;</button>
    </div>
    <div class="modal-body">
      {#if tab === "Settings"}
        <Settings />
      {:else if tab === "System Logs"}
        <SystemLogs />
      {:else if tab === "Users"}
        <UserManagement />
      {/if}
    </div>
  </div>
</div>

<style>
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
    animation: fadeIn 0.15s ease;
  }

  .modal {
    width: 80vw;
    height: 70vh;
    max-width: 960px;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--border);
    padding: 0 16px;
    flex-shrink: 0;
  }

  .tab-bar {
    display: flex;
    gap: 0;
  }

  .tab {
    padding: 10px 16px;
    background: transparent;
    color: var(--text-2);
    font-size: 12px;
    font-weight: 500;
    border-bottom: 2px solid transparent;
    transition: all 0.15s;
    margin-bottom: -1px;
  }

  .tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }

  .close-btn {
    background: none;
    color: var(--text-2);
    font-size: 14px;
    padding: 4px 8px;
  }

  .close-btn:hover {
    color: var(--text-0);
  }

  .modal-body {
    flex: 1;
    overflow: auto;
    padding: 16px;
  }
</style>
