<script lang="ts">
import type { ConversationWithParticipants, LastMessageSummary, Message } from "@volute/api";
import { fetchConversationMessages } from "../lib/client";
import { extractTextContent, formatTime, showSenderHeader } from "../lib/feed-utils";
import { formatRelativeTime, getConversationLabel, normalizeTimestamp } from "../lib/format";
import { renderMarkdown } from "../lib/markdown";

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

let topConversations = $derived(
  [...conversations]
    .filter((c) => (c as any).lastMessage)
    .sort((a, b) => {
      const aTime = new Date(normalizeTimestamp(a.updated_at)).getTime();
      const bTime = new Date(normalizeTimestamp(b.updated_at)).getTime();
      return bTime - aTime;
    })
    .slice(0, 12),
);

let messagesMap = $state<Record<string, Message[]>>({});
let scrollEls = $state<Record<string, HTMLDivElement>>({});

$effect(() => {
  const convs = topConversations;
  for (const conv of convs) {
    if (messagesMap[conv.id]) continue;
    fetchConversationMessages(conv.id, { limit: 10 })
      .then((res) => {
        messagesMap[conv.id] = res.items;
        requestAnimationFrame(() => {
          const el = scrollEls[conv.id];
          if (el) el.scrollTop = el.scrollHeight;
        });
      })
      .catch(() => {
        messagesMap[conv.id] = [];
      });
  }
});
</script>

<div class="chat-home">
  {#if topConversations.length === 0}
    <div class="empty">No conversations yet.</div>
  {:else}
    <div class="feed-grid">
      {#each topConversations as conv (conv.id)}
        {@const label = getConversationLabel(conv.participants ?? [], conv.title, username, conv)}
        {@const messages = messagesMap[conv.id] ?? []}
        <div class="feed-card" role="button" tabindex="0" onclick={() => onSelectConversation(conv.id)} onkeydown={(e) => { if (e.key === 'Enter') onSelectConversation(conv.id); }}>
          <div class="feed-card-header">
            <svg class="feed-card-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h12v8H5l-3 3V3z"/></svg>
            <span class="feed-card-label">{label}</span>
            <span class="feed-card-meta">{formatRelativeTime(conv.updated_at)}</span>
            <button
              class="card-action-btn"
              onclick={(e) => { e.stopPropagation(); onSelectConversation(conv.id); }}
            >
              Chat
            </button>
          </div>
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="feed-card-body" bind:this={scrollEls[conv.id]} onscroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollTop < 10) el.scrollTop = 10;
          }}>
            {#if messages.length === 0}
              <div class="msg-empty">Loading...</div>
            {:else}
              {#each messages as msg, i (msg.id)}
                <div class="chat-entry" class:new-sender={showSenderHeader(messages, i)}>
                  {#if showSenderHeader(messages, i)}
                    <div class="chat-entry-header">
                      <span class="chat-sender" class:chat-sender-user={msg.role === "user"}>{msg.sender_name ?? (msg.role === "user" ? "you" : "")}</span>
                      <span class="chat-timestamp">{formatTime(msg.created_at)}</span>
                    </div>
                  {/if}
                  <div class="chat-entry-content" class:chat-user-text={msg.role === "user"}>
                    {#if msg.role === "user"}
                      {extractTextContent(msg.content)}
                    {:else}
                      <div class="markdown-body">{@html renderMarkdown(extractTextContent(msg.content))}</div>
                    {/if}
                  </div>
                </div>
              {/each}
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .chat-home {
    animation: fadeIn 0.2s ease both;
    height: 100%;
    overflow: auto;
    padding: 24px;
  }

  .empty {
    color: var(--text-2);
    font-size: 13px;
    padding: 40px 0;
    text-align: center;
  }

  .feed-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 16px;
  }

  .feed-card {
    background: var(--bg-0);
    border: 1px solid color-mix(in srgb, var(--blue) 25%, var(--border));
    border-radius: var(--radius-lg);
    display: flex;
    flex-direction: column;
    height: 240px;
    overflow: hidden;
    transition: border-color 0.15s;
    cursor: pointer;
  }

  .feed-card:hover {
    border-color: color-mix(in srgb, var(--blue) 50%, var(--border));
  }

  .feed-card-header {
    padding: 6px 8px 6px 10px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-1);
    border-bottom: 1px solid color-mix(in srgb, var(--blue) 25%, var(--border));
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .feed-card-icon {
    flex-shrink: 0;
    width: 14px;
    height: 14px;
    color: var(--blue);
  }

  .feed-card-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }

  .feed-card-meta {
    font-size: 11px;
    color: var(--text-2);
    font-weight: 400;
    flex-shrink: 0;
    margin-left: auto;
  }

  .feed-card-body {
    flex: 1;
    overflow: auto;
    padding: 8px 12px;
    min-height: 0;
  }

  .card-action-btn {
    font-size: 12px;
    padding: 2px 10px;
    border-radius: var(--radius);
    cursor: pointer;
    flex-shrink: 0;
    background: var(--accent);
    border: 1px solid var(--accent);
    color: var(--bg-0);
    transition: opacity 0.15s;
  }

  .card-action-btn:hover {
    opacity: 0.85;
  }

  .msg-empty {
    color: var(--text-2);
    font-size: 13px;
    padding: 16px 0;
    text-align: center;
  }

  /* Chat entries */
  .chat-entry {
    padding: 1px 0;
  }

  .chat-entry.new-sender {
    margin-top: 8px;
  }

  .chat-entry:first-child {
    margin-top: 0;
  }

  .chat-entry-header {
    display: flex;
    align-items: baseline;
    gap: 6px;
    margin-bottom: 1px;
  }

  .chat-sender {
    font-size: 12px;
    font-weight: 600;
    color: var(--accent);
  }

  .chat-sender-user {
    color: var(--blue);
  }

  .chat-timestamp {
    font-size: 11px;
    color: var(--text-2);
  }

  .chat-entry-content {
    min-width: 0;
    font-family: var(--mono);
    font-size: 13px;
  }

  .chat-user-text {
    color: var(--text-0);
    white-space: pre-wrap;
  }

  @media (max-width: 767px) {
    .chat-home {
      padding: 16px;
    }
  }
</style>
