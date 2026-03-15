<script lang="ts">
import type { ConversationWithParticipants, TurnRow } from "@volute/api";
import ExtensionFeedCard from "../components/ExtensionFeedCard.svelte";
import HistoryEvent from "../components/HistoryEvent.svelte";
import MindInfo from "../components/MindInfo.svelte";
import MindSkills from "../components/MindSkills.svelte";
import PublicFiles from "../components/PublicFiles.svelte";
import ReadOnlyChatModal from "../components/ReadOnlyChatModal.svelte";
import { fetchTurns } from "../lib/client";
import { extractTextContent } from "../lib/feed-utils";
import { formatRelativeTime } from "../lib/format";
import { data } from "../lib/stores.svelte";

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

// --- Turns data ---
const PAGE_SIZE = 100;
let turnsData = $state<TurnRow[]>([]);
let hasMore = $state(true);
let loading = $state(false);
let historyError = $state("");

let readOnlyConv = $state<ConversationWithParticipants | null>(null);

function getSummaryTime(turn: TurnRow): string {
  return formatRelativeTime(turn.created_at);
}

// --- Unified timeline ---
type TimelineRow = {
  key: string;
  turn: TurnRow;
};

let timeline = $derived.by((): TimelineRow[] => {
  return turnsData.map((t) => ({
    key: `turn-${t.id}`,
    turn: t,
  }));
});

// --- SSE ---
let scrollContainer: HTMLDivElement | undefined = $state();
let userScrolledUp = $state(false);
let eventSource: EventSource | null = null;

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

    if (d.type !== "summary") return;

    const turnId = d.turnId as string | undefined;
    if (turnId) {
      fetchTurns(name, { limit: 1, offset: 0 })
        .then((rows) => {
          for (const row of rows) {
            if (!turnsData.some((t) => t.id === row.id)) {
              turnsData = [...turnsData, row];
            } else {
              turnsData = turnsData.map((t) => (t.id === row.id ? row : t));
            }
          }
        })
        .catch(() => {});
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
async function loadTurns(offset: number) {
  loading = true;
  historyError = "";
  try {
    const rows = await fetchTurns(name, { limit: PAGE_SIZE, offset });
    const chronological = [...rows].reverse();
    if (offset === 0) {
      turnsData = chronological;
    } else {
      turnsData = [...chronological, ...turnsData];
    }
    hasMore = rows.length === PAGE_SIZE;
  } catch (e) {
    historyError = e instanceof Error ? e.message : "Failed to load";
  }
  loading = false;
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
    turnsData = [];
    hasMore = true;
    startScrollToBottom();
    loadTurns(0);
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
              onclick={() => loadTurns(turnsData.length)}
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
                  {getSummaryTime(row.turn)}
                </div>
                <div class="track-rail track-rail-left">
                  <div class="track-dot"></div>
                </div>
                <div class="track-content track-content-left">
                  {#if row.turn.summary}
                    <HistoryEvent
                      event={{
                        id: 0,
                        mind: name,
                        channel: "",
                        session: null,
                        sender: null,
                        message_id: null,
                        type: "summary",
                        content: row.turn.summary,
                        metadata: row.turn.summary_meta ? JSON.stringify(row.turn.summary_meta) : null,
                        turn_id: row.turn.id,
                        created_at: row.turn.created_at,
                      }}
                      mindName={name}
                      expandable
                      compact
                    />
                  {:else}
                    <div class="turn-pending">processing...</div>
                  {/if}
                </div>
                <!-- Right: conversation + activity cards -->
                <div class="track-content track-content-right">
                  {#each row.turn.conversations as conv (conv.id)}
                    <div class="feed-card-wrapper">
                      <div class="feed-card card-chat" role="button" tabindex="0" onclick={() => {
                        readOnlyConv = {
                          id: conv.id,
                          mind_name: name,
                          channel: "",
                          type: conv.type,
                          name: conv.type === "channel" ? conv.label.replace(/^#/, "") : null,
                          user_id: null,
                          title: conv.label,
                          created_at: row.turn.created_at,
                          updated_at: row.turn.created_at,
                          participants: [],
                        };
                      }} onkeydown={(e) => {
                        if (e.key === 'Enter') {
                          readOnlyConv = {
                            id: conv.id,
                            mind_name: name,
                            channel: "",
                            type: conv.type,
                            name: conv.type === "channel" ? conv.label.replace(/^#/, "") : null,
                            user_id: null,
                            title: conv.label,
                            created_at: row.turn.created_at,
                            updated_at: row.turn.created_at,
                            participants: [],
                          };
                        }
                      }}>
                        <div class="feed-card-header header-chat">
                          <svg class="feed-card-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h12v8H5l-3 3V3z"/></svg>
                          <span class="feed-card-label">{conv.label}</span>
                          <span class="feed-card-meta">{conv.messages.length} message{conv.messages.length === 1 ? '' : 's'}</span>
                        </div>
                        <div class="feed-card-body chat-body">
                          {#each conv.messages.slice(-5) as msg (msg.id)}
                            <div class="chat-entry">
                              <span class="chat-sender" class:chat-sender-user={msg.role === "user"}>{msg.sender_name ?? (msg.role === "user" ? "user" : name)}</span>
                              <span class="chat-entry-content">{extractTextContent(msg.content)}</span>
                            </div>
                          {/each}
                        </div>
                      </div>
                    </div>
                  {/each}
                  {#each row.turn.activities as act (act.id)}
                    <div class="feed-card-wrapper">
                      <ExtensionFeedCard
                        title={act.summary}
                        url={act.metadata?.slug ? `/minds/${typeof act.metadata?.author === 'string' ? act.metadata.author : name}/notes/${act.metadata.slug}` : ''}
                        date={act.created_at}
                        author={typeof act.metadata?.author === 'string' ? act.metadata.author : undefined}
                        bodyHtml=""
                        icon='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2h6l4 4v8H4V2z"/><path d="M10 2v4h4"/><path d="M6 9h6M6 12h4"/></svg>'
                        color={act.type === 'page_updated' ? 'purple' : 'yellow'}
                      />
                    </div>
                  {/each}
                </div>
                <div class="track-rail track-rail-right">
                  {#if row.turn.conversations.length > 0 || row.turn.activities.length > 0}<div class="track-dot"></div>{/if}
                </div>
                <div class="track-time track-time-right">
                </div>
              </div>
            {/each}
          </div>
        {/if}

        {#if loading && turnsData.length > 0}
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
    canChat={false}
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

  .chat-body {
    padding: 8px 12px;
  }

  .chat-entry {
    padding: 1px 0;
  }
  .chat-entry:first-child {
    margin-top: 0;
  }

  .chat-sender {
    font-size: 12px;
    font-weight: 600;
    color: var(--accent);
  }
  .chat-sender-user {
    color: var(--blue);
  }

  .chat-entry-content {
    min-width: 0;
    font-family: var(--mono);
    font-size: 13px;
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

  .turn-pending {
    font-size: 12px;
    color: var(--text-2);
    padding: 8px 0;
    animation: pulse 1.5s infinite;
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
