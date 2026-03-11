<script lang="ts">
import type { Mind } from "@volute/api";
import { getDisplayStatus } from "../lib/format";
import { data } from "../lib/stores.svelte";
import History from "./History.svelte";
import StatusBadge from "./StatusBadge.svelte";

let {
  mind: initialMind,
  onClose,
  onViewProfile,
}: {
  mind: Mind;
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
  <div class="panel-header">
    <div class="header-top">
      <div class="header-left">
        <span class="mind-name">{mind.displayName ?? mind.name}</span>
      </div>
      {#if onClose}
        <button class="close-btn" onclick={onClose}>&#x2715;</button>
      {/if}
    </div>
  </div>
  <div class="panel-body">
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
      {#if onViewProfile}
        <button class="view-profile-btn" onclick={onViewProfile}>View full profile &rarr;</button>
      {/if}
    </div>

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
    display: flex;
    flex-direction: column;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .header-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 16px;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .mind-name {
    font-family: var(--display);
    font-size: 20px;
    font-weight: 400;
    color: var(--text-0);
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
    padding: 0 16px 16px;
  }

  .profile-avatar {
    width: 96px;
    height: 96px;
    border-radius: var(--radius);
    object-fit: cover;
  }

  .profile-display-name {
    font-family: var(--display);
    font-size: 24px;
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

  .view-profile-btn {
    margin-top: 8px;
    background: none;
    color: var(--accent);
    font-size: 13px;
    padding: 4px 0;
    cursor: pointer;
  }

  .view-profile-btn:hover {
    text-decoration: underline;
  }

  .history-section {
    flex: 1;
    min-height: 0;
    padding: 0 16px;
    border-top: 1px solid var(--border);
  }

  @media (max-width: 1024px) {
    .mind-panel {
      width: 100%;
    }
  }
</style>
