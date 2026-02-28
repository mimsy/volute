<script lang="ts">
import type { Mind } from "@volute/api";
import { formatRelativeTime, getDisplayStatus } from "../lib/format";
import { data } from "../lib/stores.svelte";
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
        <span class="mind-name">{mind.displayName ?? mind.name}</span>
      </div>
      {#if onClose}
        <button class="close-btn" onclick={onClose}>&#x2715;</button>
      {/if}
    </div>
    <TabBar tabs={[...TABS]} active={tab} onchange={(t) => (tab = t as Tab)} />
  </div>
  <div class="panel-body">
    {#if tab === "Info"}
      <div class="profile-section">
        <span class="profile-display-name">{mind.displayName ?? mind.name}</span>
        {#if mind.avatar}
          <img
            src={`/api/minds/${encodeURIComponent(mind.name)}/avatar`}
            alt=""
            class="profile-avatar"
          />
        {/if}
        <StatusBadge status={getDisplayStatus(mind)} />
        {#if mind.description}
          <p class="profile-description">{mind.description}</p>
        {/if}
        <span class="profile-meta">@{mind.name} &middot; since {formatCreated(mind.created)}</span>
      </div>
    {:else if tab === "History"}
      <History name={mind.name} />
    {:else if tab === "Settings"}
      <MindInfo {mind} />

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
    border-radius: var(--radius);
    object-fit: cover;
  }

  .profile-display-name {
    font-size: 18px;
    font-weight: 600;
    color: var(--text-0);
  }

  .profile-description {
    font-size: 13px;
    color: var(--text-1);
    text-align: center;
    max-width: 320px;
    margin: 4px 0 0;
    line-height: 1.4;
  }

  .profile-meta {
    font-size: 11px;
    color: var(--text-2);
    margin-top: 4px;
  }
</style>
