<script lang="ts">
import type { ConversationWithParticipants, LastMessageSummary } from "@volute/api";
import { formatRelativeTime, getConversationLabel, normalizeTimestamp } from "../lib/format";

type ConversationWithDetails = ConversationWithParticipants & {
  lastMessage?: LastMessageSummary;
};

let {
  conversations,
  username,
  onSelectConversation,
}: {
  conversations: ConversationWithDetails[];
  username: string;
  onSelectConversation: (id: string) => void;
} = $props();

let recentConversations = $derived(
  [...conversations]
    .filter((c) => (c as any).lastMessage)
    .sort((a, b) => {
      const aTime = new Date(normalizeTimestamp(a.updated_at)).getTime();
      const bTime = new Date(normalizeTimestamp(b.updated_at)).getTime();
      return bTime - aTime;
    })
    .slice(0, 30),
);
</script>

<div class="chat-home">
  <h2 class="page-title">Recent Messages</h2>
  {#if recentConversations.length === 0}
    <div class="empty">No conversations yet.</div>
  {:else}
    <div class="conv-list">
      {#each recentConversations as conv (conv.id)}
        {@const label = getConversationLabel(conv.participants ?? [], conv.title, username)}
        {@const msg = conv.lastMessage}
        <button class="conv-row" onclick={() => onSelectConversation(conv.id)}>
          <div class="conv-info">
            <span class="conv-label">{label}</span>
            <span class="conv-time">{formatRelativeTime(conv.updated_at)}</span>
          </div>
          {#if msg}
            <div class="conv-preview">
              {#if msg.senderName}<span class="sender">{msg.senderName}:</span>{/if}
              <span class="text">{msg.text}</span>
            </div>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .chat-home {
    max-width: 700px;
    margin: 0 auto;
    animation: fadeIn 0.2s ease both;
  }

  .page-title {
    font-family: var(--display);
    font-size: 22px;
    font-weight: 400;
    color: var(--text-0);
    margin: 0 0 20px;
  }

  .empty {
    color: var(--text-2);
    font-size: 13px;
    padding: 40px 0;
    text-align: center;
  }

  .conv-list {
    display: flex;
    flex-direction: column;
  }

  .conv-row {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 10px 12px;
    border-radius: var(--radius-lg);
    background: none;
    cursor: pointer;
    text-align: left;
    color: inherit;
    transition: background 0.12s;
    width: 100%;
  }

  .conv-row:hover {
    background: var(--bg-2);
  }

  .conv-info {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .conv-label {
    font-weight: 500;
    font-size: 14px;
    color: var(--text-0);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .conv-time {
    font-size: 11px;
    color: var(--text-2);
    flex-shrink: 0;
  }

  .conv-preview {
    font-size: 13px;
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .conv-preview .sender {
    color: var(--text-1);
  }
</style>
