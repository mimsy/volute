<script lang="ts">
import type { Mind } from "@volute/api";
import { getDisplayStatus } from "../lib/format";
import { data } from "../lib/stores.svelte";
import History from "./History.svelte";
import MindClock from "./MindClock.svelte";
import StatusBadge from "./StatusBadge.svelte";

let {
  mind: initialMind,
  header = false,
  onClose,
  onViewProfile,
}: {
  mind: Mind;
  header?: boolean;
  onClose?: () => void;
  onViewProfile?: () => void;
} = $props();

let mind = $derived(data.minds.find((m) => m.name === initialMind.name) ?? initialMind);

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
  {#if header}
    <div class="panel-header">
      <div class="header-top">
        <span class="mind-name">{mind.displayName ?? mind.name}</span>
        <div class="header-right">
          {#if onViewProfile}
            <button class="header-profile-btn" onclick={onViewProfile}>Profile</button>
          {/if}
          {#if onClose}
            <button class="close-btn" onclick={onClose}>&#x2715;</button>
          {/if}
        </div>
      </div>
    </div>
  {/if}
  <div class="panel-body">
    <div class="profile-section">
      {#if mind.avatar}
        <img
          src={`/api/minds/${encodeURIComponent(mind.name)}/avatar`}
          alt=""
          class="profile-avatar"
        />
      {/if}
      <span class="profile-display-name">{mind.displayName ?? mind.name}</span>
      <StatusBadge status={getDisplayStatus(mind)} />
      {#if mind.description}
        <p class="profile-description">{mind.description}</p>
      {/if}
      <span class="profile-meta">@{mind.name} &middot; since {formatCreated(mind.created)}</span>
    </div>

    <MindClock name={mind.name} />

    <div class="history-section">
      <History name={mind.name} />
    </div>
  </div>
</div>

<style>
  .mind-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-1);
    width: 100%;
    overflow: hidden;
  }

  .panel-header {
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .header-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 16px;
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .mind-name {
    font-family: var(--display);
    font-size: 20px;
    font-weight: 400;
    color: var(--text-0);
  }

  .header-profile-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-2);
    font-size: 12px;
    padding: 2px 10px;
    border-radius: var(--radius);
    cursor: pointer;
  }

  .header-profile-btn:hover {
    color: var(--text-1);
    border-color: var(--border-bright);
  }

  .close-btn {
    background: none;
    color: var(--text-2);
    font-size: 15px;
    padding: 4px 8px;
  }

  .close-btn:hover {
    color: var(--text-0);
  }

  .panel-body {
    flex: 1;
    overflow: auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .profile-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 12px 16px 16px;
  }

  .profile-avatar {
    width: 96px;
    height: 96px;
    border-radius: var(--radius);
    object-fit: cover;
  }

  .profile-display-name {
    font-family: var(--display);
    font-size: 22px;
    font-weight: 400;
    color: var(--text-0);
  }

  .profile-description {
    font-size: 14px;
    color: var(--text-1);
    text-align: center;
    max-width: 320px;
    margin: 4px 0 0;
    line-height: 1.4;
  }

  .profile-meta {
    font-size: 12px;
    color: var(--text-2);
    margin-top: 4px;
  }

  .history-section {
    flex: 1;
    min-height: 0;
    padding: 0 16px;
    border-top: 1px solid var(--border);
  }
</style>
