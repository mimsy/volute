<script lang="ts">
import type { Mind } from "@volute/api";
import { getDisplayStatus } from "../lib/format";
import { data } from "../lib/stores.svelte";
import Icon from "./Icon.svelte";
import MindClock from "./MindClock.svelte";
import StatusBadge from "./StatusBadge.svelte";
import TurnTimeline from "./TurnTimeline.svelte";

let {
  mind: initialMind,
  onProfile,
  onChat,
}: {
  mind: Mind;
  onProfile?: () => void;
  onChat?: () => void;
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
  {#if onChat || onProfile}
    <div class="floating-btns">
      {#if onChat}
        <button class="floating-btn" onclick={onChat}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h12v8H5l-3 3V3z"/></svg>
          <span class="btn-tooltip">Chat</span>
        </button>
      {/if}
      {#if onProfile}
        <button class="floating-btn" onclick={onProfile}>
          <Icon kind="history" class="history-icon" />
          <span class="btn-tooltip">History</span>
        </button>
      {/if}
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
      <span class="profile-name">{mind.displayName ?? mind.name}</span>
      <StatusBadge status={getDisplayStatus(mind)} />
      {#if mind.description}
        <p class="profile-description">{mind.description}</p>
      {/if}
      <span class="profile-meta">@{mind.name} &middot; since {formatCreated(mind.created)}</span>
    </div>

    <MindClock name={mind.name} />

    <div class="history-section">
      <TurnTimeline name={mind.name} mindStatus={mind.status} />
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
    position: relative;
  }

  .floating-btns {
    position: absolute;
    top: 8px;
    left: 8px;
    z-index: 1;
    display: flex;
    gap: 4px;
  }

  .floating-btn {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--bg-2);
    border: 1px solid var(--border);
    color: var(--text-2);
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s, background 0.15s;
  }

  .floating-btn:hover {
    color: var(--text-0);
    border-color: var(--border-bright);
    background: var(--bg-3);
  }

  .floating-btn svg {
    width: 16px;
    height: 16px;
  }

  .floating-btn :global(.history-icon) {
    width: 13px;
    height: 13px;
  }

  .btn-tooltip {
    position: absolute;
    left: 100%;
    top: 50%;
    transform: translateY(-50%);
    margin-left: 6px;
    padding: 4px 10px;
    background: var(--bg-3);
    color: var(--text-0);
    font-family: var(--sans);
    font-size: 12px;
    border-radius: var(--radius);
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.15s;
    border: 1px solid var(--border);
    z-index: 10;
  }

  .floating-btn:hover .btn-tooltip {
    opacity: 1;
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

  .profile-name {
    font-family: var(--display);
    font-size: 20px;
    font-weight: 300;
    color: var(--text-0);
    letter-spacing: 0.02em;
    margin-top: 4px;
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
