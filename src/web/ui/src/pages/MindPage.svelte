<script lang="ts">
import type {
  ConversationWithParticipants,
  HistoryMessage,
  HistorySession,
  Message,
} from "@volute/api";
import ExtensionFeedCard from "../components/ExtensionFeedCard.svelte";
import HistoryEvent from "../components/HistoryEvent.svelte";
import MindInfo from "../components/MindInfo.svelte";
import MindSkills from "../components/MindSkills.svelte";
import PublicFiles from "../components/PublicFiles.svelte";
import ReadOnlyChatModal from "../components/ReadOnlyChatModal.svelte";
import {
  fetchConversationMessages,
  fetchHistory,
  fetchHistorySessions,
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

// --- History data ---
const PAGE_SIZE = 100;
let historyMessages = $state<HistoryMessage[]>([]);
let sessions = $state<HistorySession[]>([]);
let sessionMap = $state<Map<string, HistorySession>>(new Map());
let hasMore = $state(true);
let loading = $state(false);

// --- Feed data ---
let mindConversations = $state<ConversationWithParticipants[]>([]);
let messagesMap = $state<Record<string, Message[]>>({});
let scrollEls = $state<Record<string, HTMLDivElement>>({});
let readOnlyConv = $state<ConversationWithParticipants | null>(null);
let currentUsername = $derived(auth.user?.username ?? "");

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

function getItemTime(item: InfoTimelineItem): string {
  if (item.kind === "session-divider") return "";
  if (item.kind === "summary") return formatRelativeTime(item.event.created_at);
  if (item.item.kind === "extension") return formatRelativeTime(item.item.item.date);
  return formatRelativeTime(item.item.conv.updated_at);
}

// --- Unified timeline ---
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
  return items;
});

// Group history summaries by session
type SessionGroup = {
  session: string;
  events: HistoryMessage[];
  startTime: number;
  endTime: number;
};

let sessionGroups = $derived.by(() => {
  const groups = new Map<string, HistoryMessage[]>();
  for (const m of historyMessages) {
    const key = m.session ?? "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }
  const result: SessionGroup[] = [];
  for (const [session, events] of groups) {
    const times = events.map((e) => new Date(normalizeTimestamp(e.created_at)).getTime());
    result.push({
      session,
      events,
      startTime: Math.min(...times),
      endTime: Math.max(...times),
    });
  }
  result.sort((a, b) => a.endTime - b.endTime);
  return result;
});

// Build unified timeline interleaving session groups and feed items
type InfoTimelineItem =
  | { kind: "session-divider"; session: string; key: string }
  | { kind: "summary"; event: HistoryMessage; key: string }
  | { kind: "feed"; item: FeedItem; key: string };

let timeline = $derived.by(() => {
  const items: InfoTimelineItem[] = [];

  const sortedFeed = [...feedItems].sort((a, b) => {
    const aTime = new Date(normalizeTimestamp(a.date)).getTime();
    const bTime = new Date(normalizeTimestamp(b.date)).getTime();
    return aTime - bTime;
  });

  let feedIdx = 0;

  for (const group of sessionGroups) {
    while (feedIdx < sortedFeed.length) {
      const feedTime = new Date(normalizeTimestamp(sortedFeed[feedIdx].date)).getTime();
      if (feedTime < group.startTime) {
        const fi = sortedFeed[feedIdx];
        items.push({
          kind: "feed",
          item: fi,
          key: fi.kind === "extension" ? `feed-ext-${fi.item.id}` : `feed-msg-${fi.conv.id}`,
        });
        feedIdx++;
      } else {
        break;
      }
    }

    items.push({ kind: "session-divider", session: group.session, key: `div-${group.session}` });

    for (const ev of group.events) {
      items.push({ kind: "summary", event: ev, key: `ev-${ev.id}` });
    }

    while (feedIdx < sortedFeed.length) {
      const feedTime = new Date(normalizeTimestamp(sortedFeed[feedIdx].date)).getTime();
      if (feedTime <= group.endTime) {
        const fi = sortedFeed[feedIdx];
        items.push({
          kind: "feed",
          item: fi,
          key: fi.kind === "extension" ? `feed-ext-${fi.item.id}` : `feed-msg-${fi.conv.id}`,
        });
        feedIdx++;
      } else {
        break;
      }
    }
  }

  while (feedIdx < sortedFeed.length) {
    const fi = sortedFeed[feedIdx];
    items.push({
      kind: "feed",
      item: fi,
      key: fi.kind === "extension" ? `feed-ext-${fi.item.id}` : `feed-msg-${fi.conv.id}`,
    });
    feedIdx++;
  }

  return items;
});

// --- SSE ---
let scrollContainer: HTMLDivElement | undefined = $state();
let userScrolledUp = $state(false);
let eventSource: EventSource | null = null;
let nextSseId = -1;

function connectSSE() {
  disconnectSSE();
  const url = `/api/minds/${encodeURIComponent(name)}/events`;
  const es = new EventSource(url);
  es.onmessage = (e) => {
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(e.data);
    } catch {
      return;
    }

    const event: HistoryMessage = {
      id: nextSseId--,
      mind: name,
      channel: (d.channel as string) ?? "",
      session: (d.session as string) ?? null,
      sender: null,
      message_id: (d.messageId as string) ?? null,
      type: d.type as string,
      content: (d.content as string) ?? "",
      metadata: d.metadata ? JSON.stringify(d.metadata) : null,
      created_at: (d.createdAt as string) ?? new Date().toISOString(),
    };

    if (event.type !== "summary") return;

    historyMessages = [...historyMessages, event];

    if (event.session && !sessionMap.has(event.session)) {
      const newSess: HistorySession = {
        session: event.session,
        started_at: event.created_at,
        event_count: 1,
        message_count: 0,
        tool_count: 0,
      };
      sessionMap = new Map([...sessionMap, [event.session, newSess]]);
      sessions = [newSess, ...sessions];
    }

    if (!userScrolledUp) {
      requestAnimationFrame(() => {
        scrollContainer?.scrollTo({ top: scrollContainer.scrollHeight, behavior: "smooth" });
      });
    }
  };
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      console.warn("[Info] SSE connection closed");
    }
  };
  eventSource = es;
}

function disconnectSSE() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

// --- Data loading ---
async function loadHistory(offset: number) {
  loading = true;
  try {
    const rows = await fetchHistory(name, {
      preset: "summary",
      limit: PAGE_SIZE,
      offset,
    });
    const chronological = [...rows].reverse();
    if (offset === 0) {
      historyMessages = chronological;
    } else {
      historyMessages = [...chronological, ...historyMessages];
    }
    hasMore = rows.length === PAGE_SIZE;
    if (offset === 0) {
      requestAnimationFrame(() => {
        scrollContainer?.scrollTo({ top: scrollContainer.scrollHeight });
      });
    }
  } catch (e) {
    console.warn("Failed to load history:", e);
  }
  loading = false;
}

async function loadSessions() {
  try {
    const sess = await fetchHistorySessions(name);
    sessions = sess;
    sessionMap = new Map(sess.map((s) => [s.session, s]));
  } catch (err) {
    console.warn("Failed to load sessions:", err);
  }
}

// Reload when mind name changes
let prevName = "";
$effect(() => {
  const n = name;
  if (n !== prevName) {
    prevName = n;
    historyMessages = [];
    sessions = [];
    sessionMap = new Map();
    hasMore = true;
    nextSseId = -1;
    messagesMap = {};
    loadHistory(0);
    loadSessions();
  }
});

// SSE lifecycle
$effect(() => {
  name; // track
  connectSSE();
  return () => disconnectSSE();
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

// Fetch extension feed items
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

function handleScroll() {
  if (!scrollContainer) return;
  const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
  userScrolledUp = scrollHeight - scrollTop - clientHeight > 100;
}

function jumpToLatest() {
  scrollContainer?.scrollTo({ top: scrollContainer.scrollHeight, behavior: "smooth" });
  userScrolledUp = false;
}
</script>

{#if !mind}
  <div class="not-found">Mind "{name}" not found.</div>
{:else}
  <div class="mind-page">
    {#if section === "info"}
      <div class="info-timeline" bind:this={scrollContainer} onscroll={handleScroll}>
        {#if hasMore}
          <div class="load-older">
            <button
              onclick={() => loadHistory(historyMessages.length)}
              disabled={loading}
              class="load-older-btn"
              style:opacity={loading ? 0.5 : 1}
            >
              {loading ? "loading..." : "load older"}
            </button>
          </div>
        {/if}

        {#if timeline.length === 0 && !loading}
          <div class="empty-hint">No activity yet.</div>
        {:else}
          <div class="timeline-rail">
            {#each timeline as item (item.key)}
              {#if item.kind === "session-divider"}
                <div class="session-section">
                  <div class="session-divider">
                    <div class="session-divider-line line-left"></div>
                    <span class="session-divider-label">{item.session || "no session"}</span>
                    <div class="session-divider-line"></div>
                  </div>
                </div>
              {:else if item.kind === "summary"}
                <div class="timed-row">
                  <span class="row-time">{getItemTime(item)}</span>
                  <HistoryEvent event={item.event} mindName={name} expandable compact />
                </div>
              {:else if item.kind === "feed"}
                {@const feed = item.item}
                <div class="timed-row">
                  <span class="row-time">{getItemTime(item)}</span>
                  {#if feed.kind === "extension"}
                      <div class="feed-card-wrapper">
                        <div class="feed-marker" style:background={feed.item.color ? `var(--${feed.item.color})` : "var(--text-2)"}></div>
                        <ExtensionFeedCard
                          title={feed.item.title}
                          url={feed.item.url}
                          date={feed.item.date}
                          author={feed.item.author}
                          bodyHtml={feed.item.bodyHtml}
                          iframeUrl={feed.item.iframeUrl}
                          icon={feed.item.icon}
                          color={feed.item.color}
                          onclick={() => navigate(feed.item.url)}
                        />
                      </div>
                    {:else}
                      {@const conv = feed.conv}
                      {@const label = getConvLabel(conv)}
                      {@const messages = messagesMap[conv.id] ?? []}
                      {@const participant = isUserParticipant(conv)}
                      <div class="feed-card-wrapper">
                        <div class="feed-marker" style:background="var(--blue)"></div>
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
                </div>
              {/if}
            {/each}
          </div>
        {/if}

        {#if loading && historyMessages.length > 0}
          <div class="loading-more">loading...</div>
        {/if}
      </div>

      {#if userScrolledUp}
        <button class="jump-btn" onclick={jumpToLatest}>
          jump to latest
        </button>
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
    overflow: hidden;
    position: relative;
  }

  .not-found {
    color: var(--text-2);
    padding: 40px;
    text-align: center;
  }

  /* Info timeline */
  .info-timeline {
    flex: 1;
    overflow-x: hidden;
    overflow-y: auto;
    padding: 0 40px;
  }

  .timeline-rail {
    position: relative;
    padding-left: 4px;
    margin-left: 60px;
    min-height: 100%;
  }
  .timeline-rail::before {
    content: "";
    position: absolute;
    left: 2px;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--timeline-rail);
  }

  /* Timed rows: relative time to the left of the dot */
  .timed-row {
    position: relative;
  }
  .row-time {
    position: absolute;
    right: calc(100% + 12px);
    top: 10px;
    font-size: 11px;
    color: var(--text-2);
    white-space: nowrap;
    text-align: right;
  }

  .session-section {
    position: relative;
  }

  .session-divider {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 8px 8px 8px;
  }
  .session-divider:first-child {
    padding-top: 4px;
  }
  .session-divider::before {
    content: "";
    position: absolute;
    left: -4px;
    top: 0;
    bottom: 0;
    width: 6px;
    margin-top: auto;
    margin-bottom: 14.5px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-2);
    z-index: 1;
  }
  .session-divider-line {
    flex: 1;
    border-top: 1px solid var(--border);
  }
  .line-left {
    margin-left: -6px;
  }
  .session-divider-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-2);
    white-space: nowrap;
  }

  /* Feed cards on the timeline */
  .feed-card-wrapper {
    position: relative;
    padding: 6px 8px 6px 20px;
  }
  .feed-marker {
    position: absolute;
    left: -5px;
    top: 12px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    z-index: 1;
  }

  /* Chat card */
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

  .chat-body {
    padding: 8px 12px;
  }

  .msg-empty {
    color: var(--text-2);
    font-size: 13px;
    padding: 16px 0;
    text-align: center;
  }

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

  .load-older {
    padding: 8px 0 16px;
    text-align: center;
  }

  .load-older-btn {
    padding: 4px 14px;
    background: var(--bg-3);
    color: var(--text-1);
    border-radius: var(--radius);
    font-size: 12px;
  }

  .loading-more {
    text-align: center;
    color: var(--text-2);
    font-size: 13px;
    padding: 12px;
    animation: pulse 1.5s infinite;
  }

  .jump-btn {
    position: absolute;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    padding: 6px 16px;
    background: var(--accent-dim);
    color: var(--accent);
    border-radius: var(--radius);
    font-size: 13px;
    animation: fadeIn 0.2s ease both;
    z-index: 10;
  }

  .empty-hint {
    color: var(--text-2);
    font-size: 13px;
    padding: 40px 0;
    text-align: center;
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
</style>
