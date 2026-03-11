<script lang="ts">
import type {
  ContentBlock,
  ConversationWithParticipants,
  LastMessageSummary,
  Message,
  Site,
} from "@volute/api";
import NoteCard from "../components/NoteCard.svelte";
import PageThumbnail from "../components/PageThumbnail.svelte";
import { fetchConversationMessages } from "../lib/client";
import { formatRelativeTime, getConversationLabel, normalizeTimestamp } from "../lib/format";
import { renderMarkdown } from "../lib/markdown";

type ConversationWithDetails = ConversationWithParticipants & {
  lastMessage?: LastMessageSummary;
};

interface ApiNote {
  title: string;
  author_username: string;
  slug: string;
  content: string;
  comment_count: number;
  created_at: string;
  reply_to?: { author_username: string; slug: string; title: string } | null;
  reactions?: { emoji: string; count: number }[];
}

let {
  username,
  conversations,
  sites,
  onSelectPage,
  onSelectConversation,
  onSelectNote,
}: {
  username: string;
  conversations: ConversationWithDetails[];
  sites: Site[];
  onSelectPage: (mind: string, path: string) => void;
  onSelectConversation: (id: string) => void;
  onSelectNote: (author: string, slug: string) => void;
} = $props();

let recentNotes = $state<ApiNote[]>([]);

$effect(() => {
  fetch("/api/notes?limit=8")
    .then((r) => (r.ok ? r.json() : []))
    .then((notes: ApiNote[]) => {
      recentNotes = notes;
    })
    .catch(() => {
      recentNotes = [];
    });
});

// Get one message card per recent conversation (top 6)
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

// Mixed feed sorted by date
type FeedItem =
  | { kind: "note"; note: ApiNote; date: string }
  | { kind: "page"; site: string; file: string; modified: string; date: string }
  | { kind: "message"; conv: ConversationWithDetails; date: string };

let feedItems = $derived.by(() => {
  const items: FeedItem[] = [];
  for (const note of recentNotes) {
    items.push({ kind: "note", note, date: note.created_at });
  }
  for (const site of sites) {
    for (const page of site.pages.slice(0, 3)) {
      items.push({
        kind: "page",
        site: site.name,
        file: page.file,
        modified: page.modified,
        date: page.modified,
      });
    }
  }
  for (const conv of topConversations) {
    items.push({ kind: "message", conv, date: conv.updated_at });
  }
  items.sort((a, b) => {
    const aTime = new Date(normalizeTimestamp(a.date)).getTime();
    const bTime = new Date(normalizeTimestamp(b.date)).getTime();
    return bTime - aTime;
  });
  return items;
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

<div class="home">
  {#if feedItems.length === 0}
    <div class="empty-hint">Nothing here yet.</div>
  {:else}
    <div class="feed-grid">
      {#each feedItems as item, idx (item.kind === "note" ? `note-${item.note.slug}` : item.kind === "page" ? `page-${item.site}-${item.file}` : `msg-${item.conv.id}`)}
        {#if item.kind === "note"}
          <div class="feed-item">
            <NoteCard
              title={item.note.title}
              author={item.note.author_username}
              slug={item.note.slug}
              excerpt={item.note.content.length > 120 ? `${item.note.content.slice(0, 120)}...` : item.note.content}
              commentCount={item.note.comment_count}
              createdAt={item.note.created_at}
              replyTo={item.note.reply_to}
              reactions={item.note.reactions}
              onSelect={onSelectNote}
            />
          </div>
        {:else if item.kind === "page"}
          <div class="feed-item">
            <PageThumbnail
              url="/pages/{item.site}/{item.file}"
              label="{item.site}/{item.file}"
              sublabel={formatRelativeTime(item.modified)}
              onclick={() => onSelectPage(item.site, item.file)}
            />
          </div>
        {:else}
          {@const conv = item.conv}
          {@const label = getConversationLabel(conv.participants ?? [], conv.title, username, conv)}
          {@const messages = messagesMap[conv.id] ?? []}
          <div class="feed-item message-item">
            <div class="msg-card">
              <div class="msg-label">{label}</div>
              <div class="msg-scroll" bind:this={scrollEls[conv.id]} onscroll={(e) => {
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
              <button class="msg-open-btn" onclick={() => onSelectConversation(conv.id)}>
                Open chat &rarr;
              </button>
            </div>
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .home {
    animation: fadeIn 0.2s ease both;
  }

  .empty-hint {
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

  .feed-item {
    min-width: 0;
  }

  /* Message card */
  .message-item {
    grid-column: span 1;
  }

  .msg-card {
    background: var(--bg-0);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    display: flex;
    flex-direction: column;
    height: 240px;
    overflow: hidden;
  }

  .msg-label {
    padding: 8px 12px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-1);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .msg-scroll {
    flex: 1;
    overflow: auto;
    padding: 8px 12px;
    min-height: 0;
  }

  .msg-empty {
    color: var(--text-2);
    font-size: 13px;
    padding: 16px 0;
    text-align: center;
  }

  .msg-open-btn {
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

  .msg-open-btn:hover {
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
</style>
