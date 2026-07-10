<script lang="ts">
import type {
  AwayFeedItem,
  ConversationWithParticipants,
  LastMessageSummary,
  Message,
} from "@volute/api";
import { icons } from "@volute/ui/icons";
import { renderMarkdown } from "@volute/ui/markdown";
import ExtensionFeedCard from "../components/ExtensionFeedCard.svelte";
import { AWAY_SEEN_KEY, dividerIndex } from "../lib/away-feed";
import { fetchAwayFeed, fetchConversationMessages } from "../lib/client";
import { extractTextContent, formatTime, showSenderHeader } from "../lib/feed-utils";
import { formatRelativeTime, normalizeTimestamp } from "../lib/format";

import { navigate } from "../lib/navigate";
import { data as storeData } from "../lib/stores.svelte";

type ConversationWithDetails = ConversationWithParticipants & {
  lastMessage?: LastMessageSummary;
};

let {
  username,
  conversations,
  onSelectConversation,
}: {
  username: string;
  conversations: ConversationWithDetails[];
  onSelectConversation: (id: string) => void;
} = $props();

type ExtFeedItem = {
  id: string;
  title: string;
  url: string;
  date: string;
  author?: string;
  bodyHtml: string;
  iframeUrl?: string;
  icon?: string;
  color?: string;
  extensionId: string;
};

let extensionFeedItems = $state<ExtFeedItem[]>([]);
let awayItems = $state<AwayFeedItem[]>([]);

// "While you were away": read the previous visit's watermark once, then
// advance it to now. Items newer than it sit above the divider.
function readLastSeen(): number | null {
  try {
    const v = localStorage.getItem(AWAY_SEEN_KEY);
    if (!v) return null;
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}
const lastSeenMs = readLastSeen();
try {
  localStorage.setItem(AWAY_SEEN_KEY, new Date().toISOString());
} catch {
  // Can't advance the watermark — the divider still shows against the last
  // stored visit (or stays hidden if there was never one); it just won't move.
}

// Fetch self-directed turn summaries (heartbeats, schedules, mind-to-mind)
$effect(() => {
  fetchAwayFeed()
    .then((items) => {
      awayItems = items;
    })
    .catch((err) => {
      console.warn("Failed to fetch away feed:", err);
    });
});

function mindLabel(name: string): string {
  return storeData.minds.find((m) => m.name === name)?.displayName ?? name;
}

// Fetch extension feed items from all extensions with feedSource
$effect(() => {
  const extensions = storeData.extensions;
  const items: ExtFeedItem[] = [];
  const promises = extensions
    .filter((ext) => ext.feedSource)
    .map(async (ext) => {
      try {
        const res = await fetch(ext.feedSource!.endpoint);
        if (!res.ok) return;
        const feedItems = await res.json();
        for (const item of feedItems) {
          items.push({ ...item, extensionId: ext.id });
        }
      } catch (err) {
        console.warn(`Failed to fetch ${ext.id} feed:`, err);
      }
    });
  Promise.all(promises).then(() => {
    extensionFeedItems = items;
  });
});

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

type FeedItem =
  | { kind: "message"; conv: ConversationWithDetails; date: string }
  | { kind: "extension"; item: ExtFeedItem; date: string }
  | { kind: "away"; item: AwayFeedItem; date: string };

let feedItems = $derived.by(() => {
  const items: FeedItem[] = [];
  for (const conv of topConversations) {
    items.push({ kind: "message", conv, date: conv.updated_at });
  }
  for (const extItem of extensionFeedItems) {
    items.push({ kind: "extension", item: extItem, date: extItem.date });
  }
  for (const awayItem of awayItems) {
    items.push({ kind: "away", item: awayItem, date: awayItem.created_at });
  }
  items.sort((a, b) => {
    const aTime = new Date(normalizeTimestamp(a.date)).getTime();
    const bTime = new Date(normalizeTimestamp(b.date)).getTime();
    return bTime - aTime;
  });
  return items;
});

// Where the "new since your last visit" divider goes in the newest-first feed
let dividerAt = $derived(
  dividerIndex(
    feedItems.map((i) => new Date(normalizeTimestamp(i.date)).getTime()),
    lastSeenMs,
  ),
);

function getConvLabel(conv: ConversationWithDetails): string {
  if (conv.type === "channel" && conv.channel_name) return `#${conv.channel_name}`;
  const parts = conv.participants ?? [];
  if (conv.type === "dm" && parts.length === 2) {
    const mind = parts.find((p) => p.userType === "mind");
    const other = parts.find((p) => p.username !== mind?.username);
    if (mind && other) return `@${mind.username}`;
  }
  const names = parts.map((p) => p.username);
  if (names.length > 0) return names.join(", ");
  return "Conversation";
}
</script>

<div class="home">
  {#if feedItems.length === 0}
    <div class="empty-hint">
      Nothing here yet. When your minds do things on their own, it shows up here.
    </div>
  {:else}
    <div class="feed-grid">
      {#each feedItems as item, i (item.kind === "extension" ? `ext-${item.item.id}` : item.kind === "away" ? `away-${item.item.id}` : `msg-${item.conv.id}`)}
        {#if i === dividerAt}
          <div class="feed-divider"><span class="feed-divider-label">new since your last visit ↑</span></div>
        {/if}
        {#if item.kind === "extension"}
          <div class="feed-item">
            <ExtensionFeedCard
              title={item.item.title}
              url={item.item.url}
              date={item.item.date}
              author={item.item.author}
              bodyHtml={item.item.bodyHtml}
              iframeUrl={item.item.iframeUrl}
              icon={item.item.icon}
              color={item.item.color}
              onclick={() => navigate(item.item.url)}
            />
          </div>
        {:else if item.kind === "away"}
          {@const away = item.item}
          <div class="feed-item">
            <ExtensionFeedCard
              title={mindLabel(away.mind)}
              url={`/minds/${away.mind}`}
              date={away.created_at}
              bodyHtml={away.summary}
              icon={icons.mind}
              color="purple"
              onclick={() => navigate(`/minds/${away.mind}`)}
            />
          </div>
        {:else}
          {@const conv = item.conv}
          {@const label = getConvLabel(conv)}
          {@const messages = messagesMap[conv.id] ?? []}
          <div class="feed-item">
            <div class="feed-card card-chat" role="button" tabindex="0" onclick={() => onSelectConversation(conv.id)} onkeydown={(e) => { if (e.key === 'Enter') onSelectConversation(conv.id); }}>
              <div class="feed-card-header header-chat">
                <svg class="feed-card-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h12v8H5l-3 3V3z"/></svg>
                <span class="feed-card-label">{label}</span>
                <span class="feed-card-meta">{formatRelativeTime(conv.updated_at)}</span>
                <button
                  class="card-action-btn card-action-btn-primary"
                  onclick={(e) => { e.stopPropagation(); onSelectConversation(conv.id); }}
                >
                  Chat
                </button>
              </div>
              <div class="feed-card-body chat-body" role="log" bind:this={scrollEls[conv.id]} onscroll={(e) => {
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
                          <span class="chat-sender" class:chat-sender-user={msg.role === "user"}>{msg.sender_name ?? (msg.role === "user" ? username : "")}</span>
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

  .feed-divider {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 2px 0;
  }

  .feed-divider::before,
  .feed-divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: color-mix(in srgb, var(--accent) 35%, var(--border));
  }

  .feed-divider-label {
    font-size: 11px;
    color: var(--text-2);
    white-space: nowrap;
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

  /* Card action button */
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
</style>
