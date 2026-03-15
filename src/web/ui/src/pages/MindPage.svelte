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
let historyError = $state("");

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

function getSummaryTime(ev: HistoryMessage): string {
  return formatRelativeTime(ev.created_at);
}

// Track expanded summaries and calculate feed card offsets
let expandedOffsets = $state<Record<string, number>>({});

function handleSummaryExpand(
  rowKey: string,
  summary: HistoryMessage,
  feed: FeedItem | undefined,
  expanded: boolean,
  el: HTMLDivElement | undefined,
) {
  if (!expanded || !feed || !el) {
    delete expandedOffsets[rowKey];
    expandedOffsets = { ...expandedOffsets };
    return;
  }

  const meta = summary.metadata ? JSON.parse(summary.metadata) : null;
  if (!meta?.from_time || !meta?.to_time) return;

  const from = new Date(normalizeTimestamp(meta.from_time)).getTime();
  const to = new Date(normalizeTimestamp(meta.to_time)).getTime();
  const feedTime = new Date(normalizeTimestamp(feed.date)).getTime();

  const ratio = Math.max(0, Math.min(1, (feedTime - from) / (to - from)));

  // Wait for the expanded content to render, then measure
  requestAnimationFrame(() => {
    const height = el.offsetHeight;
    // Offset the card by the ratio of the expanded height, minus half the card height to center it
    const offset = Math.round(height * ratio);
    expandedOffsets = { ...expandedOffsets, [rowKey]: offset };
  });
}

function getFeedTime(fi: FeedItem): string {
  return formatRelativeTime(fi.date);
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

// Build flat timeline sorted purely by time
type TimelineRow = {
  key: string;
  summary?: HistoryMessage;
  feed?: FeedItem;
};

let timeline = $derived.by((): TimelineRow[] => {
  // Build sorted lists
  const summaries = historyMessages
    .map((ev) => ({ ev, time: new Date(normalizeTimestamp(ev.created_at)).getTime() }))
    .sort((a, b) => a.time - b.time);

  const feeds = feedItems
    .map((fi) => ({
      fi,
      time: new Date(normalizeTimestamp(fi.date)).getTime(),
      key: fi.kind === "extension" ? `feed-ext-${fi.item.id}` : `feed-msg-${fi.conv.id}`,
    }))
    .sort((a, b) => a.time - b.time);

  // Pair feed items with summaries when the feed time falls within the summary's time range
  const pairedFeeds = new Set<number>();
  const summaryFeeds = new Map<number, typeof feeds>();

  for (let fi = 0; fi < feeds.length; fi++) {
    const feedTime = feeds[fi].time;
    for (let si = 0; si < summaries.length; si++) {
      const meta = summaries[si].ev.metadata ? JSON.parse(summaries[si].ev.metadata!) : null;
      if (!meta?.from_time || !meta?.to_time) continue;
      const from = new Date(normalizeTimestamp(meta.from_time)).getTime();
      const to = new Date(normalizeTimestamp(meta.to_time)).getTime();
      if (feedTime >= from && feedTime <= to) {
        if (!summaryFeeds.has(si)) summaryFeeds.set(si, []);
        summaryFeeds.get(si)!.push(feeds[fi]);
        pairedFeeds.add(fi);
        break;
      }
    }
  }

  // Build rows: walk through all items chronologically
  const items: { kind: "summary" | "feed"; idx: number; time: number }[] = [];
  for (let i = 0; i < summaries.length; i++) {
    items.push({ kind: "summary", idx: i, time: summaries[i].time });
  }
  for (let i = 0; i < feeds.length; i++) {
    if (!pairedFeeds.has(i)) {
      items.push({ kind: "feed", idx: i, time: feeds[i].time });
    }
  }
  items.sort((a, b) => a.time - b.time);

  const rows: TimelineRow[] = [];
  for (const item of items) {
    if (item.kind === "summary") {
      const ev = summaries[item.idx].ev;
      const paired = summaryFeeds.get(item.idx);
      if (paired && paired.length > 0) {
        // First paired feed goes side-by-side with the summary
        rows.push({
          key: `ev-${ev.id}-${paired[0].key}`,
          summary: ev,
          feed: paired[0].fi,
        });
        // Additional paired feeds get their own rows
        for (let i = 1; i < paired.length; i++) {
          rows.push({
            key: paired[i].key,
            feed: paired[i].fi,
          });
        }
      } else {
        rows.push({ key: `ev-${ev.id}`, summary: ev });
      }
    } else {
      const f = feeds[item.idx];
      rows.push({ key: f.key, feed: f.fi });
    }
  }

  return rows;
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
      turn_id: (d.turnId as string) ?? null,
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
  historyError = "";
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
  } catch (e) {
    historyError = e instanceof Error ? e.message : "Failed to load history";
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

// Scroll to bottom on initial load -- keep nudging for a few seconds
let scrollTimer: ReturnType<typeof setInterval> | null = null;
let scrollTimeout: ReturnType<typeof setTimeout> | null = null;

function startScrollToBottom() {
  stopScrollTimer();
  scrollTimer = setInterval(() => {
    if (scrollContainer) {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }
  }, 100);
  // Stop after 3 seconds
  scrollTimeout = setTimeout(() => {
    stopScrollTimer();
  }, 3000);
}

function stopScrollTimer() {
  if (scrollTimer) {
    clearInterval(scrollTimer);
    scrollTimer = null;
  }
  if (scrollTimeout) {
    clearTimeout(scrollTimeout);
    scrollTimeout = null;
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
    startScrollToBottom();
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

// Clean up scroll timer on unmount
$effect(() => {
  return () => stopScrollTimer();
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
  const distFromBottom = scrollHeight - scrollTop - clientHeight;
  userScrolledUp = distFromBottom > 100;
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
      <div class="info-timeline" bind:this={scrollContainer} onscroll={handleScroll} onwheel={() => stopScrollTimer()}>
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

        {#if historyError}
          <div class="error-hint">{historyError}</div>
        {:else if timeline.length === 0 && !loading}
          <div class="empty-hint">No activity yet.</div>
        {:else}
          <div class="two-track">
            {#each timeline as row (row.key)}
              <div class="track-row">
                <!-- Left: timestamp + summary content -->
                <div class="track-time track-time-left">
                  {#if row.summary}{getSummaryTime(row.summary)}{/if}
                </div>
                <div class="track-rail track-rail-left">
                  {#if row.summary}<div class="track-dot"></div>{/if}
                </div>
                <div class="track-content track-content-left">
                  {#if row.summary}
                    <HistoryEvent
                      event={row.summary}
                      mindName={name}
                      expandable
                      compact
                      onexpand={(exp, el) => handleSummaryExpand(row.key, row.summary!, row.feed, exp, el)}
                    />
                  {/if}
                </div>
                <!-- Right: feed card content + timestamp -->
                <div
                  class="track-content track-content-right"
                  class:track-content-animated={row.summary && row.feed}
                  style:padding-top={expandedOffsets[row.key] ? `${expandedOffsets[row.key]}px` : undefined}
                >
                  {#if row.feed}
                    {#if row.feed.kind === "extension"}
                      <div class="feed-card-wrapper">
                        <ExtensionFeedCard
                          title={row.feed.item.title}
                          url={row.feed.item.url}
                          date={row.feed.item.date}
                          author={row.feed.item.author}
                          bodyHtml={row.feed.item.bodyHtml}
                          iframeUrl={row.feed.item.iframeUrl}
                          icon={row.feed.item.icon}
                          color={row.feed.item.color}
                          onclick={() => navigate(row.feed!.kind === "extension" ? row.feed!.item.url : "")}
                        />
                      </div>
                    {:else}
                      {@const conv = row.feed.conv}
                      {@const label = getConvLabel(conv)}
                      {@const messages = messagesMap[conv.id] ?? []}
                      {@const participant = isUserParticipant(conv)}
                      <div class="feed-card-wrapper">
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
                  {/if}
                </div>
                <div class="track-rail track-rail-right">
                  {#if row.feed}<div class="track-dot"></div>{/if}
                </div>
                <div class="track-time track-time-right">
                  {#if row.feed}{getFeedTime(row.feed)}{/if}
                </div>
              </div>
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
    padding: 0 16px;
  }

  /* Two-track layout */
  .two-track {
    min-height: 100%;
    max-width: 1100px;
    margin: 0 auto;
  }

  .track-row {
    display: flex;
    align-items: flex-start;
  }

  .track-time {
    width: 60px;
    flex-shrink: 0;
    font-size: 11px;
    color: var(--text-2);
    padding-top: 10px;
    white-space: nowrap;
  }

  .track-time-left {
    text-align: right;
    padding-right: 8px;
  }

  .track-time-right {
    text-align: left;
    padding-left: 8px;
  }

  .track-rail {
    width: 2px;
    background: var(--timeline-rail);
    flex-shrink: 0;
    align-self: stretch;
    position: relative;
    min-height: 8px;
  }

  .track-dot {
    position: absolute;
    top: 12px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-2);
  }

  .track-rail-left .track-dot {
    right: -2px;
  }

  .track-rail-right .track-dot {
    left: -2px;
  }

  .track-content {
    flex: 1;
    min-width: 0;
    min-height: 1px;
  }

  .track-content-left {
    padding-right: 12px;
  }

  .track-content-right {
    padding-left: 12px;
    padding-right: 12px;
  }

  .track-content-animated {
    transition: padding-top 0.3s ease;
  }

  /* Feed cards on the timeline */
  .feed-card-wrapper {
    padding: 4px 0;
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

  .error-hint {
    color: var(--red);
    font-size: 14px;
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
