<script lang="ts">
import type { Mind } from "@volute/api";
import History from "../components/History.svelte";
import MindInfo from "../components/MindInfo.svelte";
import MindSkills from "../components/MindSkills.svelte";
import PublicFiles from "../components/PublicFiles.svelte";
import StatusBadge from "../components/StatusBadge.svelte";
import VariantList from "../components/VariantList.svelte";
import { formatRelativeTime, getDisplayStatus } from "../lib/format";
import { navigate } from "../lib/navigate";
import { data } from "../lib/stores.svelte";
import Notes from "./Notes.svelte";
import SiteView from "./SiteView.svelte";

let {
  name,
  section = "info",
  onSelectNote,
}: {
  name: string;
  section?: "info" | "notes" | "pages" | "files" | "settings";
  onSelectNote: (author: string, slug: string) => void;
} = $props();

let mind = $derived(data.minds.find((m) => m.name === name));

let connectedChannels = $derived(
  mind ? mind.channels.filter((ch) => ch.name !== "web" && ch.status === "connected") : [],
);

let site = $derived(data.sites.find((s) => s.name === name));

function formatCreated(dateStr: string): string {
  try {
    const d = new Date(dateStr.endsWith("Z") ? dateStr : `${dateStr}Z`);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  } catch {
    return dateStr;
  }
}

function handleChatClick() {
  navigate(`/chat?mind=${name}`);
}

function handleSelectPage(mind: string, path: string) {
  navigate(`/pages/${mind}/${path}`);
}
</script>

{#if !mind}
  <div class="not-found">Mind "{name}" not found.</div>
{:else}
  <div class="mind-page">
    <!-- Profile header -->
    <div class="profile-header">
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
          <StatusBadge status={getDisplayStatus(mind)} />
          {#if mind.stage === "seed"}
            <span class="seed-tag">seed</span>
          {/if}
        </div>
        {#if mind.description}
          <p class="profile-description">{mind.description}</p>
        {/if}
        <span class="profile-meta">@{mind.name} &middot; since {formatCreated(mind.created)}</span>
      </div>
      <button class="chat-btn" onclick={handleChatClick}>Chat</button>
    </div>

    <!-- Section content -->
    {#if section === "info"}
      <div class="section-content">
        <div class="info-section">
          <History {name} />
        </div>

        {#if connectedChannels.length > 0}
          <div class="detail-section">
            <div class="section-title">Connections</div>
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
          </div>
        {/if}

        <div class="detail-section">
          <div class="section-title">Variants</div>
          <VariantList {name} />
        </div>
      </div>
    {:else if section === "notes"}
      <div class="section-content">
        <Notes {onSelectNote} author={name} />
      </div>
    {:else if section === "pages"}
      <div class="section-content">
        {#if site}
          <SiteView {site} onSelectPage={handleSelectPage} />
        {:else}
          <div class="empty-hint">No published pages.</div>
        {/if}
      </div>
    {:else if section === "files"}
      <div class="section-content files-section">
        <PublicFiles {name} />
      </div>
    {:else if section === "settings"}
      <div class="section-content">
        <MindInfo {mind} />
        <div class="detail-section">
          <MindSkills {name} />
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .mind-page {
    max-width: 800px;
    margin: 0 auto;
    animation: fadeIn 0.2s ease both;
  }

  .not-found {
    color: var(--text-2);
    padding: 40px;
    text-align: center;
  }

  .profile-header {
    display: flex;
    align-items: flex-start;
    gap: 16px;
    padding-bottom: 20px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 20px;
  }

  .profile-avatar {
    width: 80px;
    height: 80px;
    border-radius: var(--radius-lg);
    object-fit: cover;
    flex-shrink: 0;
  }

  .profile-info {
    flex: 1;
    min-width: 0;
  }

  .profile-name-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }

  .profile-display-name {
    font-family: var(--display);
    font-size: 24px;
    font-weight: 400;
    color: var(--text-0);
  }

  .seed-tag {
    font-size: 10px;
    color: var(--yellow);
  }

  .profile-description {
    font-size: 14px;
    color: var(--text-1);
    line-height: 1.4;
    margin: 4px 0 0;
  }

  .profile-meta {
    font-size: 12px;
    color: var(--text-2);
    margin-top: 4px;
    display: block;
  }

  .chat-btn {
    flex-shrink: 0;
    padding: 6px 16px;
    border-radius: var(--radius);
    background: var(--accent-dim);
    color: var(--accent);
    border: 1px solid var(--accent-border);
    font-size: 13px;
    cursor: pointer;
    transition: border-color 0.15s;
  }

  .chat-btn:hover {
    border-color: var(--accent);
  }

  .section-content {
    min-height: 0;
  }

  .files-section {
    min-height: 300px;
  }

  .info-section {
    margin-bottom: 16px;
  }

  .detail-section {
    margin-top: 24px;
    padding-top: 24px;
    border-top: 1px solid var(--border);
  }

  .section-title {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-2);
    margin-bottom: 8px;
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
    font-size: 14px;
  }

  .connection-row:last-child {
    border-bottom: none;
  }

  .connection-name {
    font-weight: 500;
    color: var(--text-0);
  }

  .connection-bot {
    font-size: 13px;
    color: var(--text-1);
  }

  .connection-time {
    font-size: 12px;
    color: var(--text-2);
    margin-left: auto;
  }

  .empty-hint {
    color: var(--text-2);
    font-size: 13px;
    padding: 40px 0;
    text-align: center;
  }

  @media (max-width: 767px) {
    .profile-header {
      flex-direction: column;
      align-items: center;
      text-align: center;
    }

    .profile-name-row {
      justify-content: center;
    }
  }
</style>
