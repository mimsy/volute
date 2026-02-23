<script lang="ts">
import StatusBadge from "../components/StatusBadge.svelte";
import type {
  ActivityItem,
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

type TimelineItem =
  | { kind: "activity"; item: ActivityItem; timestamp: number }
  | { kind: "conversation"; item: ConversationWithDetails; timestamp: number };

let {
  username,
  minds,
  conversations,
  recentPages,
  activity,
  onOpenMind,
  onSelectPage,
  onSelectConversation,
}: {
  username: string;
  minds: Mind[];
  conversations: ConversationWithDetails[];
  recentPages: RecentPage[];
  activity: ActivityItem[];
  onOpenMind: (mind: Mind) => void;
  onSelectPage: (mind: string, path: string) => void;
  onSelectConversation: (id: string) => void;
} = $props();

let timelineItems = $derived.by(() => {
  const items: TimelineItem[] = [];

  for (const a of activity) {
    items.push({
      kind: "activity",
      item: a,
      timestamp: new Date(normalizeTimestamp(a.created_at)).getTime(),
    });
  }

  for (const c of conversations) {
    if (!(c as any).lastMessage) continue;
    items.push({
      kind: "conversation",
      item: c,
      timestamp: new Date(normalizeTimestamp(c.updated_at)).getTime(),
    });
  }

  items.sort((a, b) => b.timestamp - a.timestamp);
  return items.slice(0, 50);
});

let sortedMinds = $derived(
  [...minds].sort((a, b) => {
    if (a.status === "running" && b.status !== "running") return -1;
    if (a.status !== "running" && b.status === "running") return 1;
    const aTime = a.lastActiveAt ?? "";
    const bTime = b.lastActiveAt ?? "";
    return bTime.localeCompare(aTime);
  }),
);

function mindForActivity(mindName: string): Mind | undefined {
  return minds.find((m) => m.name === mindName);
}

function handleActivityClick(item: ActivityItem) {
  if (item.type === "page_updated" && item.metadata?.file) {
    onSelectPage(item.mind, item.metadata.file as string);
  } else {
    const mind = mindForActivity(item.mind);
    if (mind) onOpenMind(mind);
  }
}
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
        {#each sortedMinds as mind (mind.name)}
          {@const connectedChannels = mind.channels.filter(ch => ch.name !== "web" && ch.name !== "volute" && ch.status === "connected")}
          <button class="home-mind-card" onclick={() => onOpenMind(mind)}>
            <div class="mind-card-header">
              <span class="mind-name">{mind.name}</span>
              <StatusBadge status={getDisplayStatus(mind)} />
              {#if mind.stage === "seed"}
                <span class="seed-tag">seed</span>
              {/if}
            </div>
            {#if connectedChannels.length > 0}
              <div class="channel-row">
                {#each connectedChannels as ch (ch.name)}
                  <span class="channel-chip">{ch.displayName || ch.name}</span>
                {/each}
              </div>
            {/if}
            <div class="mind-activity">
              {mind.lastActiveAt ? `active ${formatRelativeTime(mind.lastActiveAt)}` : "no activity"}
            </div>
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Activity timeline -->
  {#if timelineItems.length > 0}
    <div class="section">
      <div class="section-header">
        <span class="section-title">activity</span>
      </div>
      <div class="timeline">
        {#each timelineItems as entry (`${entry.kind}-${entry.item.id}`)}
          {#if entry.kind === "activity"}
            {@const a = entry.item}
            <button class="timeline-row" onclick={() => handleActivityClick(a)}>
              <span class="timeline-dot" class:dot-started={a.type === "mind_started"} class:dot-stopped={a.type === "mind_stopped"} class:dot-active={a.type === "mind_active"} class:dot-idle={a.type === "mind_idle"} class:dot-page={a.type === "page_updated"}></span>
              <span class="timeline-text">{a.summary}</span>
              <span class="timeline-time">{formatRelativeTime(a.created_at)}</span>
            </button>
          {:else}
            {@const c = entry.item}
            {@const label = getConversationLabel(c.participants ?? [], c.title, username)}
            {@const msg = c.lastMessage}
            <button class="timeline-row" onclick={() => onSelectConversation(c.id)}>
              <span class="timeline-dot dot-message"></span>
              <span class="timeline-text">
                <span class="conv-label">{label}:</span>
                {#if msg}
                  {msg.senderName ? `${msg.senderName}: ` : ""}{msg.text}
                {/if}
              </span>
              <span class="timeline-time">{formatRelativeTime(c.updated_at)}</span>
            </button>
          {/if}
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
    text-align: left;
    color: inherit;
    font-size: inherit;
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

  .timeline {
    display: flex;
    flex-direction: column;
  }

  .timeline-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
    border-radius: var(--radius-lg);
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    color: inherit;
    font-size: 12px;
    transition: background 0.12s;
    width: 100%;
  }

  .timeline-row:hover {
    background: var(--bg-2);
  }

  .timeline-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--text-2);
  }

  .dot-started {
    background: var(--accent);
  }

  .dot-stopped {
    background: var(--text-2);
  }

  .dot-active {
    background: var(--accent);
  }

  .dot-idle {
    background: var(--text-2);
  }

  .dot-page {
    background: var(--yellow);
  }

  .dot-message {
    background: var(--blue, var(--accent));
  }

  .timeline-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-1);
  }

  .timeline-text .conv-label {
    color: var(--text-0);
    font-weight: 500;
  }

  .timeline-time {
    color: var(--text-2);
    font-size: 10px;
    flex-shrink: 0;
  }
</style>
