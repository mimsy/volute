<script lang="ts">
import { fetchMinds, type Mind, startMind, stopMind } from "../lib/api";
import { formatRelativeTime, getDisplayStatus } from "../lib/format";
import { data } from "../lib/stores.svelte";
import History from "./History.svelte";
import MindInfo from "./MindInfo.svelte";
import MindSkills from "./MindSkills.svelte";
import StatusBadge from "./StatusBadge.svelte";
import TabBar from "./TabBar.svelte";
import VariantList from "./VariantList.svelte";

let { mind: initialMind, onClose }: { mind: Mind; onClose: () => void } = $props();

const TABS = ["Info", "History", "Skills", "Variants", "Connections"] as const;
type Tab = (typeof TABS)[number];

let mind = $derived(data.minds.find((m) => m.name === initialMind.name) ?? initialMind);
let tab = $state<Tab>("History");
let error = $state("");
let actionLoading = $state(false);

async function handleStart() {
  actionLoading = true;
  error = "";
  try {
    await startMind(mind.name);
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to start";
  }
  fetchMinds()
    .then((m) => {
      data.minds = m;
    })
    .catch(() => {});
  actionLoading = false;
}

async function handleStop() {
  actionLoading = true;
  error = "";
  try {
    await stopMind(mind.name);
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to stop";
  }
  fetchMinds()
    .then((m) => {
      data.minds = m;
    })
    .catch(() => {});
  actionLoading = false;
}

const connectedChannels = $derived(
  mind.channels.filter((ch) => ch.name !== "web" && ch.status === "connected"),
);
</script>

<div class="mind-panel">
  <div class="panel-header">
    <div class="header-top">
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
      <button class="close-btn" onclick={onClose}>&#x2715;</button>
    </div>
    <TabBar tabs={[...TABS]} active={tab} onchange={(t) => (tab = t as Tab)} />
  </div>
  <div class="panel-body">
    {#if error}
      <div class="error-msg">{error}</div>
    {/if}
    {#if tab === "Info"}
      <MindInfo name={mind.name} />
    {:else if tab === "History"}
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
</div>

<style>
  .mind-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-1);
    border-left: 1px solid var(--border);
    width: 480px;
    flex-shrink: 0;
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    flex-direction: column;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .header-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 16px 0;
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

  .close-btn {
    background: none;
    color: var(--text-2);
    font-size: 14px;
    padding: 4px 8px;
  }

  .close-btn:hover {
    color: var(--text-0);
  }

  .panel-body {
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
