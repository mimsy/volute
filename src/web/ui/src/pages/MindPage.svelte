<script lang="ts">
import type { ConversationWithParticipants, Message } from "@volute/api";
import ExtensionFeedCard from "../components/ExtensionFeedCard.svelte";
import MindInfo from "../components/MindInfo.svelte";
import MindSkills from "../components/MindSkills.svelte";
import PublicFiles from "../components/PublicFiles.svelte";
import ReadOnlyChatModal from "../components/ReadOnlyChatModal.svelte";
import {
  fetchConversationMessages,
  fetchMindConversationMessages,
  fetchMindConversations,
} from "../lib/client";
import { extractTextContent, formatTime, showSenderHeader } from "../lib/feed-utils";
import { formatRelativeTime, normalizeTimestamp } from "../lib/format";
import { renderMarkdown } from "../lib/markdown";
import { navigate } from "../lib/navigate";
import { auth, data } from "../lib/stores.svelte";

let {
  name,
  section = "info",
  subpath,
}: {
  name: string;
  section?: string;
  subpath?: string;
} = $props();

let mind = $derived(data.minds.find((m) => m.name === name));

let mindConversations = $state<ConversationWithParticipants[]>([]);
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
  if (conv.type === "dm" && parts.length === 2) {
    const other = parts.find((p) => p.username !== name);
    if (other) return `@${other.username}`;
  }
  const others = parts.filter((p) => p.username !== name);
  if (others.length > 0) return others.map((p) => `@${p.username}`).join(", ");
  if (conv.title) return conv.title;
  return "Conversation";
}

// Extension feed items for the info section
type ExtFeedItem = {
  id: string;
  title: string;
  url: string;
  date: string;
  author?: string;
  bodyHtml: string;
  extensionId: string;
};

let extensionFeedItems = $state<ExtFeedItem[]>([]);

type FeedItem =
  | { kind: "extension"; item: ExtFeedItem; date: string }
  | { kind: "message"; conv: ConversationWithParticipants; date: string };

let feedItems = $derived.by(() => {
  const items: FeedItem[] = [];
  for (const extItem of extensionFeedItems) {
    items.push({ kind: "extension", item: extItem, date: extItem.date });
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
    .catch((err) => {
      console.warn("Failed to load mind conversations:", err);
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
      .catch((err) => {
        console.warn(`Failed to load messages for conversation ${conv.id}:`, err);
        messagesMap[conv.id] = [];
      });
  }
});

// Fetch extension feed items scoped to this mind
$effect(() => {
  const mindName = name;
  const extensions = data.extensions;
  const items: ExtFeedItem[] = [];
  const promises = extensions
    .filter((ext) => ext.feedSource)
    .map(async (ext) => {
      try {
        const res = await fetch(`${ext.feedSource!.endpoint}?mind=${encodeURIComponent(mindName)}`);
        if (!res.ok) return;
        const feedItems = await res.json();
        for (const item of feedItems) {
          items.push({ ...item, extensionId: ext.id });
        }
      } catch {
        // skip
      }
    });
  Promise.all(promises).then(() => {
    extensionFeedItems = items;
  });
});
</script>

{#if !mind}
  <div class="not-found">Mind "{name}" not found.</div>
{:else}
  <div class="mind-page">
    {#if section === "info"}
      <!-- Mixed feed -->
      {#if feedItems.length === 0}
        <div class="empty-hint">No activity yet.</div>
      {:else}
        <div class="feed-grid">
          {#each feedItems as item (item.kind === "extension" ? `ext-${item.item.id}` : `msg-${item.conv.id}`)}
            {#if item.kind === "extension"}
              <div class="feed-item">
                <ExtensionFeedCard
                  title={item.item.title}
                  url={item.item.url}
                  date={item.item.date}
                  author={item.item.author}
                  bodyHtml={item.item.bodyHtml}
                  onclick={() => navigate(item.item.url)}
                />
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
    {:else if section?.startsWith("ext:")}
      {@const extParts = section.split(":")}
      <div class="section-content">
        {#if subpath && extParts[1] === "pages"}
          <iframe src="/ext/{extParts[1]}/public/{name}/{subpath}" class="ext-iframe page-content-iframe" title="Page content"></iframe>
        {:else}
          <iframe src="/ext/{extParts[1]}/#/mind/{name}{subpath ? '/' + subpath : ''}" class="ext-iframe" title="Extension"></iframe>
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
    overflow: auto;
  }

  .not-found {
    color: var(--text-2);
    padding: 40px;
    text-align: center;
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

  .card-chat .feed-card-icon { color: var(--blue); }

  .card-chat { border-color: color-mix(in srgb, var(--blue) 25%, var(--border)); }

  .card-chat .feed-card-header { border-bottom-color: color-mix(in srgb, var(--blue) 25%, var(--border)); }

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

  .ext-iframe {
    width: 100%;
    height: 100%;
    border: none;
    background: var(--bg-0);
  }

  .page-content-iframe {
    background: white;
  }

  .empty-hint {
    color: var(--text-2);
    font-size: 13px;
    padding: 40px 0;
    text-align: center;
  }



</style>
