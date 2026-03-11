<script lang="ts">
import type {
  ContentBlock,
  ConversationWithParticipants,
  LastMessageSummary,
  Message,
} from "@volute/api";
import { fetchConversationMessages } from "../lib/client";
import { getConversationLabel, normalizeTimestamp } from "../lib/format";
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
    .slice(0, 6),
);

let messagesMap = $state<Record<string, Message[]>>({});
let scrollEls = $state<Record<string, HTMLDivElement>>({});

$effect(() => {
  const convs = topConversations;
  for (const conv of convs) {
    if (messagesMap[conv.id]) continue;
    fetchConversationMessages(conv.id, { limit: 20 })
      .then((res) => {
        messagesMap[conv.id] = res.items.reverse();
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

function formatTime(dateStr: string): string {
  try {
    const d = new Date(dateStr.endsWith("Z") ? dateStr : `${dateStr}Z`);
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function showSenderHeader(messages: Message[], i: number): boolean {
  if (i === 0) return true;
  const prev = messages[i - 1];
  const cur = messages[i];
  return (prev.sender_name ?? prev.role) !== (cur.sender_name ?? cur.role);
}

function extractTextContent(content: ContentBlock[]): string {
  return content
    .filter((b): b is ContentBlock & { type: "text" } => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");
}
</script>

<div class="chat-home">
  {#if topConversations.length === 0}
    <div class="empty">No conversations yet.</div>
  {:else}
    <div class="viewport-grid">
      {#each topConversations as conv (conv.id)}
        {@const label = getConversationLabel(conv.participants ?? [], conv.title, username, conv)}
        {@const messages = messagesMap[conv.id] ?? []}
        <div class="viewport-card">
          <div class="viewport-label">{label}</div>
          <div class="viewport-scroll" bind:this={scrollEls[conv.id]} onscroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollTop < 10) el.scrollTop = 10;
          }}>
            {#if messages.length === 0}
              <div class="viewport-empty">Loading...</div>
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
          <button class="viewport-open-btn" onclick={() => onSelectConversation(conv.id)}>
            Open chat &rarr;
          </button>
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
  }

  .empty {
    color: var(--text-2);
    font-size: 13px;
    padding: 40px 0;
    text-align: center;
  }

  .viewport-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 16px;
    height: 100%;
    grid-template-rows: repeat(3, minmax(200px, 1fr));
  }

  .viewport-card {
    background: var(--bg-0);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    display: flex;
    flex-direction: column;
    min-height: 200px;
    overflow: hidden;
  }

  .viewport-label {
    padding: 8px 12px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-1);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .viewport-scroll {
    flex: 1;
    overflow: auto;
    padding: 8px 12px;
    min-height: 0;
  }

  .viewport-empty {
    color: var(--text-2);
    font-size: 13px;
    padding: 16px 0;
    text-align: center;
  }

  .viewport-open-btn {
    display: block;
    width: 100%;
    padding: 6px;
    background: var(--accent-dim);
    color: var(--accent);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    border-top: 1px solid var(--border);
    text-align: center;
    flex-shrink: 0;
    transition: background 0.15s;
  }

  .viewport-open-btn:hover {
    background: var(--accent-bg);
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
    .viewport-grid {
      grid-template-columns: 1fr;
      grid-template-rows: auto;
    }

    .viewport-card {
      max-height: 250px;
    }
  }
</style>
