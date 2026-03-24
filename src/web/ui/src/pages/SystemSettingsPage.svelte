<script lang="ts">
import ExtensionManager from "../components/system/ExtensionManager.svelte";
import MindDefaults from "../components/system/MindDefaults.svelte";
import SharedSkills from "../components/system/SharedSkills.svelte";
import SystemLogs from "../components/system/SystemLogs.svelte";
import UserManagement from "../components/system/UserManagement.svelte";
import { restartDaemon } from "../lib/client";
import { navigate } from "../lib/navigate";
import { data } from "../lib/stores.svelte";
import Prompts from "./Prompts.svelte";
import Settings from "./Settings.svelte";

const TABS = [
  "settings",
  "mind-defaults",
  "prompts",
  "skills",
  "extensions",
  "logs",
  "users",
] as const;
type Tab = (typeof TABS)[number];

const TAB_LABELS: Record<Tab, string> = {
  settings: "Settings",
  "mind-defaults": "Mind Defaults",
  prompts: "Prompts",
  skills: "Skills",
  extensions: "Extensions",
  logs: "System Logs",
  users: "Users",
};

let {
  section,
}: {
  section?: string;
} = $props();

let activeTab = $derived<Tab>(TABS.includes(section as Tab) ? (section as Tab) : "settings");

let restarting = $state(false);
let restartError = $state<string | null>(null);

async function handleRestart() {
  restarting = true;
  restartError = null;
  try {
    await restartDaemon();
  } catch (err) {
    restartError = err instanceof Error ? err.message : "Unknown error";
    console.warn("Failed to restart daemon:", err);
  } finally {
    restarting = false;
  }
}
</script>

<div class="settings-page">
  <div class="settings-header">
    <div class="tab-row">
      {#each TABS as tab}
        <button
          class="settings-tab"
          class:active={activeTab === tab}
          onclick={() => navigate(tab === "settings" ? "/settings" : `/settings/${tab}`)}
        >{TAB_LABELS[tab]}</button>
      {/each}
    </div>
    <div class="restart-area">
      {#if restartError}
        <span class="restart-error">Failed: {restartError}</span>
      {/if}
      <button
        class="restart-btn"
        onclick={handleRestart}
        disabled={restarting}
      >{restarting ? "Restarting..." : "Restart Daemon"}</button>
    </div>
  </div>
  <div class="settings-body">
    {#if activeTab === "settings"}
      <Settings />
    {:else if activeTab === "mind-defaults"}
      <MindDefaults />
    {:else if activeTab === "prompts"}
      <Prompts />
    {:else if activeTab === "skills"}
      <SharedSkills />
    {:else if activeTab === "extensions"}
      <ExtensionManager />
    {:else if activeTab === "logs"}
      <SystemLogs />
    {:else if activeTab === "users"}
      <UserManagement minds={data.minds} />
    {/if}
  </div>
</div>

<style>
  .settings-page {
    display: flex;
    flex-direction: column;
    height: 100%;
    animation: fadeIn 0.2s ease both;
  }

  .settings-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--border);
    padding: 0 16px;
    flex-shrink: 0;
  }

  .tab-row {
    display: flex;
    gap: 0;
  }

  .settings-tab {
    padding: 10px 14px;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-2);
    font-size: 13px;
    cursor: pointer;
    white-space: nowrap;
  }

  .settings-tab:hover {
    color: var(--text-1);
  }

  .settings-tab.active {
    color: var(--text-0);
    border-bottom-color: var(--accent);
  }

  .restart-area {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .restart-error {
    font-size: 12px;
    color: var(--red, #f87171);
  }

  .restart-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-2);
    font-size: 12px;
    padding: 4px 10px;
    border-radius: var(--radius);
    cursor: pointer;
    flex-shrink: 0;
  }

  .restart-btn:hover:not(:disabled) {
    color: var(--text-1);
    border-color: var(--border-bright);
  }

  .restart-btn:disabled {
    opacity: 0.5;
  }

  .settings-body {
    flex: 1;
    overflow: auto;
    padding: 16px;
  }
</style>
