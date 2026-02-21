<script lang="ts">
import { onMount } from "svelte";
import { fetchMind, type Mind, startMind, stopMind } from "../lib/api";
import { formatRelativeTime, getDisplayStatus } from "../lib/format";
import History from "./History.svelte";
import MindSkills from "./MindSkills.svelte";
import Modal from "./Modal.svelte";
import StatusBadge from "./StatusBadge.svelte";
import TabBar from "./TabBar.svelte";
import VariantList from "./VariantList.svelte";

let { mind: initialMind, onClose }: { mind: Mind; onClose: () => void } = $props();

const TABS = ["History", "Skills", "Variants", "Connections"] as const;
type Tab = (typeof TABS)[number];

const mindName = initialMind.name;
// eslint-disable-next-line svelte/valid-compile -- initialMind is intentionally captured once; refresh() updates mind via API
let mind = $state<Mind>(initialMind);
let tab = $state<Tab>("History");
let error = $state("");
let actionLoading = $state(false);

function refresh() {
  fetchMind(mindName)
    .then((m) => {
      mind = m;
      error = "";
    })
    .catch(() => {});
}

onMount(() => {
  refresh();
  const interval = setInterval(refresh, 5000);
  return () => clearInterval(interval);
});

async function handleStart() {
  actionLoading = true;
  try {
    await startMind(mind.name);
    refresh();
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to start";
  }
  actionLoading = false;
}

async function handleStop() {
  actionLoading = true;
  try {
    await stopMind(mind.name);
    refresh();
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to stop";
  }
  actionLoading = false;
}

const connectedChannels = $derived(
  mind.channels.filter((ch) => ch.name !== "web" && ch.status === "connected"),
);
</script>

<Modal size="full" {onClose}>
  <div class="modal-header">
    <div class="header-left">
      <span class="mind-name">{mind.name}</span>
      <StatusBadge status={getDisplayStatus(mind)} />
      {#if mind.status === "stopped"}
        <button
          onclick={handleStart}
          disabled={actionLoading}
          class="action-btn start-btn"
          style:opacity={actionLoading ? 0.5 : 1}
        >
          {actionLoading ? "Starting..." : "Start"}
        </button>
      {:else}
        <button
          onclick={handleStop}
          disabled={actionLoading}
          class="action-btn stop-btn"
          style:opacity={actionLoading ? 0.5 : 1}
        >
          {actionLoading ? "Stopping..." : "Stop"}
        </button>
      {/if}
    </div>
    <div class="header-right">
      <TabBar tabs={[...TABS]} active={tab} onchange={(t) => (tab = t as Tab)} />
      <button class="close-btn" onclick={onClose}>&#x2715;</button>
    </div>
  </div>
  <div class="modal-body">
    {#if error}
      <div class="error-msg">{error}</div>
    {/if}
    {#if tab === "History"}
      <History name={mind.name} />
    {:else if tab === "Skills"}
      <MindSkills name={mind.name} />
    {:else if tab === "Variants"}
      <VariantList name={mind.name} />
    {:else if tab === "Connections"}
      {#if connectedChannels.length === 0}
        <div class="connections-empty">No active connections.</div>
      {:else}
        <div class="connections-list">
          {#each connectedChannels as channel}
            <div class="connection-card">
              <div class="connection-icon">&#10687;</div>
              <div class="connection-info">
                <div class="connection-header">
                  <span class="connection-name">{channel.displayName}</span>
                  <StatusBadge status="connected" />
                </div>
                {#if channel.username}
                  <div class="connection-bot">
                    Bot: <span class="bot-name">{channel.username}</span>
                  </div>
                {/if}
                {#if channel.connectedAt}
                  <div class="connection-time">
                    Connected {formatRelativeTime(channel.connectedAt)}
                  </div>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</Modal>

<style>
  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--border);
    padding: 0 16px;
    flex-shrink: 0;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .mind-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-0);
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 0;
  }

  .close-btn {
    background: none;
    color: var(--text-2);
    font-size: 14px;
    padding: 4px 8px;
    margin-left: 8px;
  }

  .close-btn:hover {
    color: var(--text-0);
  }

  .modal-body {
    flex: 1;
    overflow: auto;
    padding: 16px;
  }

  .error-msg {
    color: var(--red);
    margin-bottom: 12px;
    font-size: 13px;
  }

  .action-btn {
    padding: 4px 12px;
    border-radius: var(--radius);
    font-size: 11px;
    font-weight: 500;
    transition: opacity 0.15s;
  }

  .start-btn {
    background: var(--accent-dim);
    color: var(--accent);
  }

  .stop-btn {
    background: var(--red-dim);
    color: var(--red);
  }

  .connections-empty {
    color: var(--text-2);
    padding: 24px;
    text-align: center;
  }

  .connections-list {
    padding: 8px 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .connection-card {
    display: flex;
    align-items: flex-start;
    gap: 16px;
    padding: 16px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }

  .connection-icon {
    width: 40px;
    height: 40px;
    border-radius: var(--radius);
    background: var(--bg-3);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    color: var(--accent);
    flex-shrink: 0;
  }

  .connection-info {
    flex: 1;
    min-width: 0;
  }

  .connection-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }

  .connection-name {
    font-weight: 600;
    color: var(--text-0);
  }

  .connection-bot {
    font-size: 13px;
    color: var(--text-1);
    margin-bottom: 4px;
  }

  .bot-name {
    color: var(--text-0);
  }

  .connection-time {
    font-size: 11px;
    color: var(--text-2);
  }
</style>
