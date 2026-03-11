<script lang="ts">
import type { ContentBlock, ConversationWithParticipants, Message } from "@volute/api";
import { fetchMindConversationMessages } from "../lib/client";
import { renderMarkdown } from "../lib/markdown";
import { navigate } from "../lib/navigate";
import Modal from "./Modal.svelte";

let {
  mindName,
  conversation,
  canChat = false,
  onClose,
}: {
  mindName: string;
  conversation: ConversationWithParticipants;
  canChat?: boolean;
  onClose: () => void;
} = $props();

let messages = $state<Message[]>([]);
let loading = $state(true);
let scrollEl = $state<HTMLDivElement | undefined>();

let label = $derived.by(() => {
  if (conversation.type === "channel" && conversation.name) return `#${conversation.name}`;
  const parts = conversation.participants ?? [];
  const others = parts.filter((p) => p.username !== mindName);
  if (others.length > 0) return others.map((p) => `@${p.username}`).join(", ");
  if (conversation.title) return conversation.title;
  return "Conversation";
});

$effect(() => {
  loading = true;
  fetchMindConversationMessages(mindName, conversation.id, { limit: 50 })
    .then((res) => {
      messages = res.items;
      requestAnimationFrame(() => {
        if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
      });
    })
    .catch(() => {
      messages = [];
    })
    .finally(() => {
      loading = false;
    });
});

function formatTime(dateStr: string): string {
  try {
    const d = new Date(dateStr.endsWith("Z") ? dateStr : `${dateStr}Z`);
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr.endsWith("Z") ? dateStr : `${dateStr}Z`);
    return d.toLocaleDateString();
  } catch {
    return "";
  }
}

function showSenderHeader(i: number): boolean {
  if (i === 0) return true;
  const prev = messages[i - 1];
  const cur = messages[i];
  return (prev.sender_name ?? prev.role) !== (cur.sender_name ?? cur.role);
}

function showDate(i: number): boolean {
  if (i === 0) return true;
  return formatDate(messages[i].created_at) !== formatDate(messages[i - 1].created_at);
}

function extractTextContent(content: ContentBlock[]): string {
  return content
    .filter((b): b is ContentBlock & { type: "text" } => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");
}
</script>

<Modal onClose={onClose} title={label}>
  {#snippet headerActions()}
    {#if canChat}
      <button class="open-chat-btn" onclick={() => { onClose(); navigate(`/chat/${conversation.id}`); }}>Chat</button>
    {/if}
  {/snippet}
  <div class="read-only-chat">
    {#if loading}
      <div class="chat-empty">Loading...</div>
    {:else if messages.length === 0}
      <div class="chat-empty">No messages.</div>
    {:else}
      <div class="chat-scroll" bind:this={scrollEl}>
        {#each messages as msg, i (msg.id)}
          {#if showDate(i)}
            <div class="date-divider">
              <div class="divider-line"></div>
              <span>{formatDate(msg.created_at)}</span>
              <div class="divider-line"></div>
            </div>
          {/if}
          <div class="chat-entry" class:new-sender={showSenderHeader(i)}>
            {#if showSenderHeader(i)}
              <div class="chat-entry-header">
                <span class="chat-sender" class:chat-sender-user={msg.role === "user"}>{msg.sender_name ?? (msg.role === "user" ? "user" : mindName)}</span>
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
      </div>
    {/if}
  </div>
</Modal>

<style>
  .open-chat-btn {
    font-size: 12px;
    padding: 3px 12px;
    border-radius: var(--radius);
    cursor: pointer;
    background: var(--accent);
    border: 1px solid var(--accent);
    color: var(--bg-0);
    font-weight: 500;
    transition: opacity 0.15s;
  }

  .open-chat-btn:hover {
    opacity: 0.85;
  }

  .read-only-chat {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .chat-empty {
    color: var(--text-2);
    font-size: 13px;
    padding: 40px;
    text-align: center;
  }

  .chat-scroll {
    flex: 1;
    overflow: auto;
    padding: 12px 16px;
    min-height: 0;
  }

  .date-divider {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 16px 0;
    color: var(--text-2);
    font-size: 12px;
  }

  .divider-line {
    flex: 1;
    height: 1px;
    background: var(--border);
  }

  .chat-entry {
    padding: 2px 0;
  }

  .chat-entry.new-sender {
    margin-top: 12px;
  }

  .chat-entry:first-child {
    margin-top: 0;
  }

  .chat-entry-header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 2px;
  }

  .chat-sender {
    font-size: 14px;
    font-weight: 600;
    color: var(--accent);
  }

  .chat-sender-user {
    color: var(--blue);
  }

  .chat-timestamp {
    font-size: 12px;
    color: var(--text-2);
  }

  .chat-entry-content {
    min-width: 0;
    font-family: var(--mono);
    font-size: 14px;
  }

  .chat-user-text {
    color: var(--text-0);
    white-space: pre-wrap;
  }
</style>
