<script lang="ts">
import { fetchMinds, type Mind, startMind, stopMind } from "../lib/api";
import { formatRelativeTime, getDisplayStatus, mindDotColor } from "../lib/format";
import { activeMinds, data } from "../lib/stores.svelte";
import History from "./History.svelte";
import MindInfo from "./MindInfo.svelte";
import MindSkills from "./MindSkills.svelte";
import StatusBadge from "./StatusBadge.svelte";
import TabBar from "./TabBar.svelte";
import VariantList from "./VariantList.svelte";

let { mind: initialMind, onClose }: { mind: Mind; onClose?: () => void } = $props();

const TABS = ["Info", "History", "Settings"] as const;
type Tab = (typeof TABS)[number];

let mind = $derived(data.minds.find((m) => m.name === initialMind.name) ?? initialMind);
let tab = $state<Tab>("Info");
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

function formatCreated(dateStr: string): string {
  try {
    const d = new Date(dateStr.endsWith("Z") ? dateStr : `${dateStr}Z`);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  } catch {
    return dateStr;
  }
}
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
      {#if onClose}
        <button class="close-btn" onclick={onClose}>&#x2715;</button>
      {/if}
    </div>
    <TabBar tabs={[...TABS]} active={tab} onchange={(t) => (tab = t as Tab)} />
  </div>
  <div class="panel-body">
    {#if error}
      <div class="error-msg">{error}</div>
    {/if}
    {#if tab === "Info"}
      <div class="profile-section">
        {#if mind.avatar}
          <img
            src={`/api/minds/${encodeURIComponent(mind.name)}/avatar`}
            alt=""
            class="profile-avatar"
          />
        {/if}
        <div class="profile-info">
          <div class="profile-name-row">
            <span class="profile-display-name">{mind.displayName ?? mind.name}</span>
            <span
              class="profile-dot"
              class:iridescent={activeMinds.has(mind.name)}
              style:background={activeMinds.has(mind.name) ? undefined : mindDotColor(mind)}
            ></span>
          </div>
          {#if mind.displayName}
            <span class="profile-handle">@{mind.name}</span>
          {/if}
          {#if mind.description}
            <p class="profile-description">{mind.description}</p>
          {/if}
          <span class="profile-created">{mind.stage === "seed" ? "Planted" : "Sprouted"} {formatCreated(mind.created)}</span>
        </div>
      </div>
    {:else if tab === "History"}
      <History name={mind.name} />
    {:else if tab === "Settings"}
      <MindInfo name={mind.name} />

      <div class="detail-section">
        <MindSkills name={mind.name} />
      </div>

      <div class="detail-section">
        <div class="section-title">Connections</div>
        {#if connectedChannels.length === 0}
          <div class="connections-empty">No active connections.</div>
        {:else}
          <div class="connections-list">
            {#each connectedChannels as channel}
              <div class="connection-row">
                <span class="connection-name">{channel.displayName}</span>
                <StatusBadge status="connected" />
                {#if channel.username}
                  <span class="connection-bot">{channel.username}</span>
                {/if}
                {#if channel.connectedAt}
                  <span class="connection-time">{formatRelativeTime(channel.connectedAt)}</span>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <div class="detail-section">
        <div class="section-title">Variants</div>
        <VariantList name={mind.name} />
      </div>
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

  .detail-section {
    margin-top: 24px;
    padding-top: 24px;
    border-top: 1px solid var(--border);
  }

  .section-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-2);
    margin-bottom: 8px;
  }

  .connections-empty {
    color: var(--text-2);
    padding: 12px 0;
    font-size: 13px;
  }

  .connections-list {
    display: flex;
    flex-direction: column;
  }

  .connection-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }

  .connection-row:last-child {
    border-bottom: none;
  }

  .connection-name {
    font-weight: 500;
    color: var(--text-0);
  }

  .connection-bot {
    font-size: 12px;
    color: var(--text-1);
  }

  .connection-time {
    font-size: 11px;
    color: var(--text-2);
    margin-left: auto;
  }

  .profile-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    padding: 16px 0;
  }

  .profile-avatar {
    width: 96px;
    height: 96px;
    border-radius: 50%;
    object-fit: cover;
  }

  .profile-info {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }

  .profile-name-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .profile-display-name {
    font-size: 18px;
    font-weight: 600;
    color: var(--text-0);
  }

  .profile-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .profile-dot.iridescent {
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

  .profile-handle {
    font-size: 13px;
    color: var(--text-2);
  }

  .profile-description {
    font-size: 13px;
    color: var(--text-1);
    text-align: center;
    max-width: 320px;
    margin: 4px 0 0;
    line-height: 1.4;
  }

  .profile-created {
    font-size: 11px;
    color: var(--text-2);
    margin-top: 4px;
  }
</style>
