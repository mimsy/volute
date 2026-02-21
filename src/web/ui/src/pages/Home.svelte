<script lang="ts">
import StatusBadge from "../components/StatusBadge.svelte";
import type {
  ConversationWithParticipants,
  LastMessageSummary,
  Mind,
  RecentPage,
} from "../lib/api";
import {
  formatRelativeTime,
  getConversationLabel,
  getDisplayStatus,
  normalizeTimestamp,
} from "../lib/format";

type ConversationWithDetails = ConversationWithParticipants & {
  lastMessage?: LastMessageSummary;
};

let {
  username,
  minds,
  conversations,
  recentPages,
  onOpenMind,
  onSelectPage,
}: {
  username: string;
  minds: Mind[];
  conversations: ConversationWithDetails[];
  recentPages: RecentPage[];
  onOpenMind: (mind: Mind) => void;
  onSelectPage: (mind: string, path: string) => void;
} = $props();

let sortedMinds = $derived(
  [...minds].sort((a, b) => {
    if (a.status === "running" && b.status !== "running") return -1;
    if (a.status !== "running" && b.status === "running") return 1;
    const aTime = a.lastActiveAt ?? "";
    const bTime = b.lastActiveAt ?? "";
    return bTime.localeCompare(aTime);
  }),
);

let recentConversations = $derived(
  [...conversations]
    .sort((a, b) => {
      return (
        new Date(normalizeTimestamp(b.updated_at)).getTime() -
        new Date(normalizeTimestamp(a.updated_at)).getTime()
      );
    })
    .slice(0, 5),
);
</script>

<div class="home">
  <!-- Minds -->
  <div class="section">
    <div class="section-header">
      <span class="section-title">minds</span>
    </div>
    {#if minds.length === 0}
      <div class="empty-hint">
        No minds registered. Run <code class="code-hint">volute mind create &lt;name&gt;</code> to get started.
      </div>
    {:else}
      <div class="mind-row">
        {#each sortedMinds as mind}
          {@const connectedChannels = mind.channels.filter(ch => ch.name !== "web" && ch.name !== "volute" && ch.status === "connected")}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="home-mind-card" onclick={() => onOpenMind(mind)} onkeydown={() => {}}>
            <div class="mind-card-header">
              <span class="mind-name">{mind.name}</span>
              <StatusBadge status={getDisplayStatus(mind)} />
              {#if mind.stage === "seed"}
                <span class="seed-tag">seed</span>
              {/if}
            </div>
            {#if connectedChannels.length > 0}
              <div class="channel-row">
                {#each connectedChannels as ch}
                  <span class="channel-chip">{ch.displayName || ch.name}</span>
                {/each}
              </div>
            {/if}
            <div class="mind-activity">
              {mind.lastActiveAt ? `active ${formatRelativeTime(mind.lastActiveAt)}` : "no activity"}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Recent conversations -->
  {#if recentConversations.length > 0}
    <div class="section">
      <div class="section-header">
        <span class="section-title">recent conversations</span>
      </div>
      <div class="conv-list">
        {#each recentConversations as conv}
          {@const label = getConversationLabel(conv.participants ?? [], conv.title, username)}
          {@const isSeed = minds.find(a => a.name === conv.mind_name)?.stage === "seed"}
          {@const msg = conv.lastMessage}
          <a href={`/chats/${conv.id}`} class="conv-card">
            <div class="conv-content">
              <div class="conv-header">
                <span class="conv-label">{label}</span>
                {#if isSeed}
                  <span class="seed-tag">seed</span>
                {/if}
              </div>
              {#if msg}
                <div class="conv-preview">
                  {msg.senderName ? `${msg.senderName}: ` : ""}{msg.text}
                </div>
              {/if}
            </div>
            <span class="conv-time">{formatRelativeTime(conv.updated_at)}</span>
          </a>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Recent pages -->
  {#if recentPages.length > 0}
    <div class="section">
      <div class="section-header">
        <span class="section-title">recent pages</span>
      </div>
      <div class="pages-list">
        {#each recentPages as page}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="page-row" onclick={() => onSelectPage(page.mind, page.file)} onkeydown={() => {}}>
            <span>
              <span class="page-mind">{page.mind}/</span>{page.file}
            </span>
            <span class="page-time">{formatRelativeTime(page.modified)}</span>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .home {
    max-width: 800px;
    animation: fadeIn 0.2s ease both;
  }

  .section {
    margin-bottom: 24px;
  }

  .section-header {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 8px;
  }

  .section-title {
    color: var(--text-2);
  }

  .empty-hint {
    color: var(--text-2);
    font-size: 12px;
  }

  .code-hint {
    color: var(--text-1);
  }

  .mind-row {
    display: flex;
    gap: 10px;
    overflow-x: auto;
    padding-bottom: 4px;
  }

  .home-mind-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 14px;
    border-radius: var(--radius-lg);
    background: var(--bg-2);
    border: 1px solid var(--border);
    min-width: 150px;
    transition: border-color 0.15s;
    flex-shrink: 0;
    cursor: pointer;
  }

  .home-mind-card:hover {
    border-color: var(--border-bright);
  }

  .mind-card-header {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .mind-name {
    color: var(--text-0);
    font-weight: 500;
    font-size: 13px;
  }

  .seed-tag {
    font-size: 9px;
    color: var(--yellow);
  }

  .channel-row {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }

  .channel-chip {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--accent-dim);
    color: var(--accent);
  }

  .mind-activity {
    font-size: 10px;
    color: var(--text-2);
  }

  .conv-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .conv-card {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    border-radius: var(--radius-lg);
    background: var(--bg-2);
    border: 1px solid var(--border);
    transition: border-color 0.15s;
  }

  .conv-card:hover {
    border-color: var(--border-bright);
  }

  .conv-content {
    flex: 1;
    min-width: 0;
  }

  .conv-header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 2px;
  }

  .conv-label {
    color: var(--text-0);
    font-weight: 500;
    font-size: 12px;
  }

  .conv-preview {
    font-size: 11px;
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .conv-time {
    color: var(--text-2);
    font-size: 10px;
    flex-shrink: 0;
  }

  .pages-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .page-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    border-radius: var(--radius);
    background: var(--bg-2);
    border: 1px solid var(--border);
    color: var(--text-0);
    font-size: 12px;
    transition: border-color 0.15s;
    cursor: pointer;
  }

  .page-row:hover {
    border-color: var(--border-bright);
  }

  .page-mind {
    color: var(--text-2);
  }

  .page-time {
    color: var(--text-2);
    font-size: 10px;
  }
</style>
