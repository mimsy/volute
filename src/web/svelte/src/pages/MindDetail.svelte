<script lang="ts">
import FileEditor from "../components/FileEditor.svelte";
import History from "../components/History.svelte";
import LogViewer from "../components/LogViewer.svelte";
import StatusBadge from "../components/StatusBadge.svelte";
import VariantList from "../components/VariantList.svelte";
import { fetchMind, type Mind, startMind, stopMind } from "../lib/api";
import { formatRelativeTime } from "../lib/format";

let { name }: { name: string } = $props();

const TABS = ["History", "Logs", "Files", "Variants", "Connections"] as const;
type Tab = (typeof TABS)[number];

let mind = $state<Mind | null>(null);
let tab = $state<Tab>("History");
let error = $state("");
let actionLoading = $state(false);

function refresh() {
  fetchMind(name)
    .then((m) => {
      mind = m;
      error = "";
    })
    .catch(() => {
      error = "Mind not found";
    });
}

$effect(() => {
  refresh();
  const interval = setInterval(refresh, 5000);
  return () => clearInterval(interval);
});

async function handleStart() {
  actionLoading = true;
  try {
    await startMind(name);
    refresh();
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to start";
  }
  actionLoading = false;
}

async function handleStop() {
  actionLoading = true;
  try {
    await stopMind(name);
    refresh();
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to stop";
  }
  actionLoading = false;
}
</script>

{#if error && !mind}
  <div class="error-msg">{error}</div>
{:else if !mind}
  <div class="loading">Loading...</div>
{:else}
  <div class="mind-detail">
    <!-- Mind header -->
    <div class="mind-header">
      <div class="header-left">
        <StatusBadge status={mind.status} />
        <span class="port">:{mind.port}</span>
        {#each mind.channels.filter((ch) => ch.name !== "web" && ch.status === "connected") as ch}
          <StatusBadge status="connected" />
        {/each}
      </div>
      <div class="header-right">
        {#if mind.hasPages}
          <a
            href={`/pages/${mind.name}/`}
            target="_blank"
            rel="noopener noreferrer"
            class="pages-link"
          >
            Pages
          </a>
        {/if}
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
    </div>

    <!-- Tabs -->
    <div class="tab-bar">
      {#each TABS as t}
        <button
          class="tab"
          class:active={t === tab}
          onclick={() => (tab = t)}
        >
          {t}
        </button>
      {/each}
    </div>

    <!-- Tab content -->
    <div class="tab-content">
      {#if tab === "History"}
        <History {name} />
      {:else if tab === "Logs"}
        <LogViewer {name} />
      {:else if tab === "Files"}
        <FileEditor {name} />
      {:else if tab === "Variants"}
        <VariantList {name} />
      {:else if tab === "Connections"}
        {@const connectedChannels = mind.channels.filter(
          (ch) => ch.name !== "web" && ch.status === "connected",
        )}
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
{/if}

<style>
  .error-msg {
    color: var(--red);
    padding: 24px;
  }

  .loading {
    color: var(--text-2);
    padding: 24px;
  }

  .mind-detail {
    display: flex;
    flex-direction: column;
    height: calc(100vh - 48px - 48px);
    animation: fadeIn 0.2s ease both;
  }

  .mind-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
    flex-shrink: 0;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .port {
    color: var(--text-2);
    font-size: 12px;
  }

  .header-right {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .pages-link {
    padding: 6px 16px;
    background: var(--bg-2);
    color: var(--text-1);
    border-radius: var(--radius);
    font-size: 12px;
    font-weight: 500;
    text-decoration: none;
    border: 1px solid var(--border);
  }

  .action-btn {
    padding: 6px 16px;
    border-radius: var(--radius);
    font-size: 12px;
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

  .tab-bar {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border);
    margin-bottom: 0;
    flex-shrink: 0;
  }

  .tab {
    padding: 8px 16px;
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

  .tab-content {
    flex: 1;
    overflow: hidden;
    padding-top: 12px;
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
