<script lang="ts">
import type { ContentBlock, ConversationWithParticipants, Message } from "@volute/api";
import MindInfo from "../components/MindInfo.svelte";
import MindRightPanel from "../components/MindRightPanel.svelte";
import MindSkills from "../components/MindSkills.svelte";
import PublicFiles from "../components/PublicFiles.svelte";
import ReadOnlyChatModal from "../components/ReadOnlyChatModal.svelte";
import {
  fetchConversationMessages,
  fetchMindConversationMessages,
  fetchMindConversations,
} from "../lib/client";
import { formatRelativeTime, normalizeTimestamp } from "../lib/format";
import { renderMarkdown } from "../lib/markdown";
import { navigate } from "../lib/navigate";
import { auth, data } from "../lib/stores.svelte";
import Notes from "./Notes.svelte";
import SiteView from "./SiteView.svelte";

let {
  name,
  section = "info",
}: {
  name: string;
  section?: "info" | "notes" | "pages" | "files" | "settings";
} = $props();

let mind = $derived(data.minds.find((m) => m.name === name));

let site = $derived(data.sites.find((s) => s.name === name));

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

let mindConversations = $state<ConversationWithParticipants[]>([]);
let recentNotes = $state<ApiNote[]>([]);
let messagesMap = $state<Record<string, Message[]>>({});
let scrollEls = $state<Record<string, HTMLDivElement>>({});
let readOnlyConv = $state<ConversationWithParticipants | null>(null);

let currentUsername = $derived(auth.user?.username ?? "");

function isUserParticipant(conv: ConversationWithParticipants): boolean {
  if (!currentUsername) return false;
  return (conv.participants ?? []).some((p) => p.username === currentUsername);
}

function getConvLabel(conv: ConversationWithParticipants): string {
  if (conv.type === "channel" && conv.name) return `#${conv.name}`;
  const parts = conv.participants ?? [];
  // For a DM, show the non-mind participant
  if (conv.type === "dm" && parts.length === 2) {
    const other = parts.find((p) => p.username !== name);
    if (other) return `@${other.username}`;
  }
  // For groups, show non-mind participants
  const others = parts.filter((p) => p.username !== name);
  if (others.length > 0) return others.map((p) => `@${p.username}`).join(", ");
  if (conv.title) return conv.title;
  return "Conversation";
}

// Mixed feed of notes, pages, and conversations sorted by date
type FeedItem =
  | { kind: "note"; note: ApiNote; date: string }
  | { kind: "page"; file: string; modified: string; date: string }
  | { kind: "message"; conv: ConversationWithParticipants; date: string };

let feedItems = $derived.by(() => {
  const items: FeedItem[] = [];
  for (const note of recentNotes) {
    items.push({ kind: "note", note, date: note.created_at });
  }
  if (site) {
    for (const page of site.pages.slice(0, 4)) {
      items.push({ kind: "page", file: page.file, modified: page.modified, date: page.modified });
    }
  }
  for (const conv of mindConversations) {
    if ((conv as any).lastMessage) {
      items.push({ kind: "message", conv, date: conv.updated_at });
    }
  }
  items.sort((a, b) => {
    const aTime = new Date(normalizeTimestamp(a.date)).getTime();
    const bTime = new Date(normalizeTimestamp(b.date)).getTime();
    return bTime - aTime;
  });
  return items;
});

// Fetch mind conversations
$effect(() => {
  const mindName = name;
  messagesMap = {};
  fetchMindConversations(mindName)
    .then((convs) => {
      mindConversations = convs;
    })
    .catch(() => {
      mindConversations = [];
    });
});

// Fetch messages for each conversation
$effect(() => {
  const convs = mindConversations;
  for (const conv of convs) {
    if (messagesMap[conv.id]) continue;
    const isParticipant = isUserParticipant(conv);
    const fetchFn = isParticipant
      ? fetchConversationMessages(conv.id, { limit: 10 })
      : fetchMindConversationMessages(name, conv.id, { limit: 10 });
    fetchFn
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

$effect(() => {
  const mindName = name;
  fetch(`/api/notes?author=${encodeURIComponent(mindName)}&limit=6`)
    .then((r) => (r.ok ? r.json() : []))
    .then((notes: ApiNote[]) => {
      recentNotes = notes;
    })
    .catch(() => {
      recentNotes = [];
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

function handleSelectPage(mind: string, path: string) {
  navigate(`/minds/${mind}/pages/${path}`);
}

function handleSelectNote(author: string, slug: string) {
  navigate(`/minds/${author}/notes/${slug}`);
}

function showSenderHeader(messages: Message[], i: number): boolean {
  if (i === 0) return true;
  const prev = messages[i - 1];
  const cur = messages[i];
  return (prev.sender_name ?? prev.role) !== (cur.sender_name ?? cur.role);
}

function scaleIframe(node: HTMLElement) {
  const iframe = node.querySelector("iframe") as HTMLIFrameElement;
  if (!iframe) return;
  const update = () => {
    const w = node.clientWidth;
    if (w > 0) iframe.style.transform = `scale(${w / 1280})`;
  };
  const ro = new ResizeObserver(update);
  ro.observe(node);
  update();
  return { destroy: () => ro.disconnect() };
}

function extractTextContent(content: ContentBlock[]): string {
  return content
    .filter((b): b is ContentBlock & { type: "text" } => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");
}
</script>

{#if !mind}
  <div class="not-found">Mind "{name}" not found.</div>
{:else}
  <div class="mind-page">
    {#if section === "info"}
      <div class="info-split">
        <div class="info-left">
          <!-- Mixed feed -->
          {#if feedItems.length === 0}
            <div class="empty-hint">No activity yet.</div>
          {:else}
            <div class="feed-grid">
              {#each feedItems as item (item.kind === "note" ? `note-${item.note.slug}` : item.kind === "page" ? `page-${item.file}` : `msg-${item.conv.id}`)}
                {#if item.kind === "note"}
                  {@const note = item.note}
                  <div class="feed-item">
                    <div class="feed-card card-note" role="button" tabindex="0" onclick={() => handleSelectNote(note.author_username, note.slug)} onkeydown={(e) => { if (e.key === 'Enter') handleSelectNote(note.author_username, note.slug); }}>
                      <div class="feed-card-header header-note">
                        <svg class="feed-card-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h8M2 6h10M2 9h6M2 12h9"/></svg>
                        <span class="feed-card-label">{note.title}</span>
                        <span class="feed-card-meta">{formatRelativeTime(note.created_at)}</span>
                      </div>
                      <div class="feed-card-body note-body">
                        <p class="note-excerpt">{note.content.length > 300 ? `${note.content.slice(0, 300)}...` : note.content}</p>
                        {#if note.comment_count > 0}
                          <span class="note-comments">{note.comment_count} {note.comment_count === 1 ? "comment" : "comments"}</span>
                        {/if}
                      </div>
                    </div>
                  </div>
                {:else if item.kind === "page"}
                  <div class="feed-item">
                    <div class="feed-card card-page" role="button" tabindex="0" onclick={() => handleSelectPage(name, item.file)} onkeydown={(e) => { if (e.key === 'Enter') handleSelectPage(name, item.file); }}>
                      <div class="feed-card-header header-page">
                        <svg class="feed-card-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M2 5.5h12"/></svg>
                        <span class="feed-card-label">{item.file}</span>
                        <span class="feed-card-meta">{formatRelativeTime(item.modified)}</span>
                      </div>
                      <div class="feed-card-body page-body" use:scaleIframe>
                        <iframe src="/pages/{name}/{item.file}" loading="lazy" sandbox="allow-same-origin" tabindex={-1} title={item.file}></iframe>
                      </div>
                    </div>
                  </div>
                {:else}
                  {@const conv = item.conv}
                  {@const label = getConvLabel(conv)}
                  {@const messages = messagesMap[conv.id] ?? []}
                  {@const participant = isUserParticipant(conv)}
                  <div class="feed-item">
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <div class="feed-card card-chat" role="button" tabindex="0" onclick={() => { readOnlyConv = conv; }} onkeydown={(e) => { if (e.key === 'Enter') readOnlyConv = conv; }}>
                      <div class="feed-card-header header-chat">
                        <svg class="feed-card-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h12v8H5l-3 3V3z"/></svg>
                        <span class="feed-card-label">{label}</span>
                        <span class="feed-card-meta">{formatRelativeTime(conv.updated_at)}</span>
                        {#if participant}
                          <button
                            class="card-action-btn card-action-btn-primary"
                            onclick={(e) => { e.stopPropagation(); navigate(`/chat/${conv.id}`); }}
                          >
                            Chat
                          </button>
                        {/if}
                      </div>
                      <!-- svelte-ignore a11y_no_static_element_interactions -->
                      <div class="feed-card-body chat-body" bind:this={scrollEls[conv.id]} onscroll={(e) => {
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
                                  <span class="chat-sender" class:chat-sender-user={msg.role === "user"}>{msg.sender_name ?? (msg.role === "user" ? "user" : name)}</span>
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
                  </div>
                {/if}
              {/each}
            </div>
          {/if}
        </div>

        <div class="info-right">
          {#if mind}
            <MindRightPanel {mind} onChat={() => navigate(`/chat?mind=${name}`)} />
          {/if}
        </div>
      </div>
    {:else if section === "notes"}
      <div class="section-content">
        <Notes author={name} />
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

{#if readOnlyConv}
  <ReadOnlyChatModal
    mindName={name}
    conversation={readOnlyConv}
    canChat={isUserParticipant(readOnlyConv)}
    onClose={() => { readOnlyConv = null; }}
  />
{/if}

<style>
  .mind-page {
    animation: fadeIn 0.2s ease both;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .not-found {
    color: var(--text-2);
    padding: 40px;
    text-align: center;
  }

  /* Split layout — history on right spans full height */
  .info-split {
    display: flex;
    gap: 24px;
    flex: 1;
    min-height: 0;
  }

  .info-left {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 16px;
    overflow: auto;
  }

  .info-right {
    width: 420px;
    flex-shrink: 0;
    min-height: 0;
    background: var(--bg-1);
    border-left: 1px solid var(--border);
    margin: -24px -24px -24px 0;
  }

  /* Feed grid */
  .feed-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 16px;
  }

  .feed-item {
    min-width: 0;
  }

  /* Unified card */
  .feed-card {
    background: var(--bg-0);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    display: flex;
    flex-direction: column;
    height: 240px;
    overflow: hidden;
    transition: border-color 0.15s;
  }

  .feed-card[role="button"] {
    cursor: pointer;
  }

  .feed-card-header {
    padding: 6px 8px 6px 10px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-1);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .feed-card-icon {
    flex-shrink: 0;
    width: 14px;
    height: 14px;
  }

  .card-note .feed-card-icon { color: var(--yellow); }
  .card-page .feed-card-icon { color: var(--purple); }
  .card-chat .feed-card-icon { color: var(--blue); }

  .card-note { border-color: color-mix(in srgb, var(--yellow) 25%, var(--border)); }
  .card-page { border-color: color-mix(in srgb, var(--purple) 25%, var(--border)); }
  .card-chat { border-color: color-mix(in srgb, var(--blue) 25%, var(--border)); }

  .card-note .feed-card-header { border-bottom-color: color-mix(in srgb, var(--yellow) 25%, var(--border)); }
  .card-page .feed-card-header { border-bottom-color: color-mix(in srgb, var(--purple) 25%, var(--border)); }
  .card-chat .feed-card-header { border-bottom-color: color-mix(in srgb, var(--blue) 25%, var(--border)); }

  .card-note:hover { border-color: color-mix(in srgb, var(--yellow) 50%, var(--border)); }
  .card-page:hover { border-color: color-mix(in srgb, var(--purple) 50%, var(--border)); }
  .card-chat:hover { border-color: color-mix(in srgb, var(--blue) 50%, var(--border)); }

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
    padding: 10px 12px;
    min-height: 0;
  }

  /* Card action button (chat cards) */
  .card-action-btn {
    font-size: 12px;
    padding: 2px 10px;
    border-radius: var(--radius);
    cursor: pointer;
    flex-shrink: 0;
    background: none;
    border: 1px solid var(--border);
    color: var(--text-2);
    transition: color 0.15s, border-color 0.15s;
  }

  .card-action-btn:hover {
    color: var(--text-1);
    border-color: var(--border-bright);
  }

  .card-action-btn-primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--bg-0);
  }

  .card-action-btn-primary:hover {
    opacity: 0.85;
    color: var(--bg-0);
    border-color: var(--accent);
  }

  /* Note card body */
  .note-body {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }

  .note-excerpt {
    font-size: 13px;
    color: var(--text-1);
    margin: 0;
    overflow: hidden;
    line-height: 1.5;
    flex: 1;
  }

  .note-comments {
    font-size: 11px;
    color: var(--text-2);
    flex-shrink: 0;
    margin-top: 6px;
  }

  /* Page card body */
  .page-body {
    padding: 0;
    overflow: hidden;
    position: relative;
  }

  .page-body iframe {
    position: absolute;
    top: 0;
    left: 0;
    width: 1280px;
    height: 960px;
    transform-origin: top left;
    pointer-events: none;
    border: none;
    background: white;
  }

  /* Chat card body */
  .chat-body {
    padding: 8px 12px;
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

  /* Other sections */
  .section-content {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .files-section {
    min-height: 300px;
  }

  .detail-section {
    margin-top: 24px;
    padding-top: 24px;
    border-top: 1px solid var(--border);
  }

  .empty-hint {
    color: var(--text-2);
    font-size: 13px;
    padding: 40px 0;
    text-align: center;
  }

  @media (max-width: 1024px) {
    .info-right {
      display: none;
    }
  }

</style>
