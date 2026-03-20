<script lang="ts">
import type {
  ConversationWithParticipants,
  HistoryMessage,
  TurnConversation,
  TurnRow,
} from "@volute/api";
import { SvelteMap } from "svelte/reactivity";
import { fetchHistory, fetchTurnEvents, fetchTurns } from "../lib/client";
import { extractTextContent } from "../lib/feed-utils";
import { formatRelativeTime } from "../lib/format";
import { navigate } from "../lib/navigate";
import ExtensionFeedCard from "./ExtensionFeedCard.svelte";
import HistoryEvent from "./HistoryEvent.svelte";
import ReadOnlyChatModal from "./ReadOnlyChatModal.svelte";

let { name }: { name?: string } = $props();

// --- Turns data ---
const PAGE_SIZE = 100;
let turnsData = $state<TurnRow[]>([]);
let hasMore = $state(true);
let loading = $state(false);
let historyError = $state("");

let readOnlyConv = $state<ConversationWithParticipants | null>(null);

// --- Streaming events for active turns ---
let streamingEvents = $state(new SvelteMap<string, HistoryMessage[]>());
let nextSyntheticId = -1;
// Inbound events that arrived before any turn_created — shown as provisional turn
let pendingInbounds = $state<HistoryMessage[]>([]);
// Fallback timers for done events that may not be followed by a summary
const doneFallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();
let expandedTurns = $state(new Set<string>());

function buildHistoryMessage(
  d: Record<string, unknown>,
  overrides: Partial<HistoryMessage> = {},
): HistoryMessage {
  return {
    id: nextSyntheticId--,
    mind: (d.mind as string) ?? name ?? "",
    channel: (d.channel as string) ?? "",
    session: (d.session as string) ?? null,
    sender: (d.sender as string) ?? null,
    message_id: (d.messageId as string) ?? null,
    type: (d.type as string) ?? "",
    content: (d.content as string) ?? "",
    metadata: d.metadata ? JSON.stringify(d.metadata) : null,
    turn_id: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function upsertTurnRows(rows: TurnRow[]) {
  for (const row of rows) {
    if (!turnsData.some((t) => t.id === row.id)) {
      turnsData = [...turnsData, row];
    } else {
      turnsData = turnsData.map((t) => (t.id === row.id ? row : t));
    }
  }
}

function openConversation(conv: TurnConversation, turn: TurnRow) {
  readOnlyConv = {
    id: conv.id,
    mind_name: turn.mind,
    channel: "",
    type: conv.type,
    name: conv.type === "channel" ? conv.label.replace(/^#/, "") : null,
    user_id: null,
    title: conv.label,
    created_at: turn.created_at,
    updated_at: turn.created_at,
    private: 0,
    participants: [],
  };
}

function handleExpand(turnId: string, expanded: boolean) {
  if (expanded) {
    expandedTurns.add(turnId);
  } else {
    expandedTurns.delete(turnId);
  }
  expandedTurns = new Set(expandedTurns);
}

type StreamingConv = {
  channel: string;
  label: string;
  type: "dm" | "channel";
  messages: { role: "user" | "assistant"; sender: string | null; content: string }[];
};

function getStreamingConversations(events: HistoryMessage[], mindName: string): StreamingConv[] {
  const byChannel = new Map<string, StreamingConv>();
  for (const ev of events) {
    if ((ev.type !== "inbound" && ev.type !== "outbound") || !ev.channel) continue;
    let conv = byChannel.get(ev.channel);
    if (!conv) {
      // Derive label from channel slug: "@user" → "@user", "discord:server/chan" → "#server/chan"
      const slug = ev.channel;
      const colonIdx = slug.indexOf(":");
      const raw = colonIdx >= 0 ? slug.substring(colonIdx + 1) : slug;
      const isDM = slug.startsWith("@");
      conv = {
        channel: slug,
        label: isDM ? raw : raw.startsWith("#") ? raw : `#${raw}`,
        type: isDM ? "dm" : "channel",
        messages: [],
      };
      byChannel.set(slug, conv);
    }
    conv.messages.push({
      role: ev.type === "inbound" ? "user" : "assistant",
      sender: ev.type === "inbound" ? ev.sender : mindName,
      content: ev.content,
    });
  }
  return [...byChannel.values()];
}

// --- SSE ---
let scrollContainer: HTMLDivElement | undefined = $state();
let userScrolledUp = $state(false);
let eventSource: EventSource | null = null;

function connectSSE() {
  disconnectSSE();
  const params = name ? `?mind=${encodeURIComponent(name)}` : "";
  const url = `/api/v1/history/events${params}`;
  const es = new EventSource(url);
  es.onmessage = (e) => {
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(e.data);
    } catch (err) {
      console.warn("[TurnTimeline] Failed to parse SSE event:", e.data, err);
      return;
    }

    const turnId = d.turnId as string | undefined;
    const eventType = d.type as string;
    if (eventType === "inbound" && !turnId) {
      // Show immediately as provisional turn before turn_created arrives
      pendingInbounds = [...pendingInbounds, buildHistoryMessage(d)];
    } else if (eventType === "turn_created" && turnId) {
      // Promote pending inbounds into the real turn's streaming events
      if (!turnsData.some((t) => t.id === turnId)) {
        turnsData = [
          ...turnsData,
          {
            id: turnId,
            mind: (d.mind as string) ?? name ?? "",
            summary: null,
            summary_meta: null,
            status: "active",
            created_at: new Date().toISOString(),
            trigger: null,
            conversations: [],
            activities: [],
          },
        ];
      }
      // Always merge pending inbounds into the turn (even if already initialized by backfill/duplicate)
      if (pendingInbounds.length > 0) {
        const seeded = pendingInbounds.map((ev) => ({ ...ev, turn_id: turnId }));
        const prev = streamingEvents.get(turnId) ?? [];
        streamingEvents.set(turnId, [...seeded, ...prev]);
      } else if (!streamingEvents.has(turnId)) {
        streamingEvents.set(turnId, []);
      }
      pendingInbounds = [];
      // Fetch turn events from DB after a short delay to allow retroactive inbound tagging.
      // DB events are authoritative — replace synthetic SSE events entirely.
      // Any SSE events arriving after this .then() runs are appended normally.
      const turnMind = (d.mind as string) ?? name ?? "";
      new Promise((r) => setTimeout(r, 500))
        .then(() => fetchTurnEvents(turnMind, { turnId }))
        .then((dbEvents) => {
          if (!streamingEvents.has(turnId)) return; // turn already completed
          streamingEvents.set(turnId, dbEvents);
        })
        .catch((err) => console.warn("[TurnTimeline] Failed to fetch turn events:", err));
    } else if (eventType === "summary" && turnId) {
      // Turn complete — fetch the specific turn row and remove streaming state
      clearTimeout(doneFallbackTimers.get(turnId));
      doneFallbackTimers.delete(turnId);
      const prevStreaming = streamingEvents.get(turnId);
      streamingEvents.delete(turnId);
      fetchTurns({ mind: name, turnId })
        .then((rows) => {
          upsertTurnRows(rows);
          // Scroll the completed turn into view after DOM update
          requestAnimationFrame(() => {
            const el = scrollContainer?.querySelector(`[data-turn-id="${turnId}"]`);
            el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
          });
        })
        .catch((err) => {
          console.warn("[TurnTimeline] Failed to fetch completed turn:", err);
          // Restore streaming state so the turn doesn't vanish
          if (!streamingEvents.has(turnId)) {
            streamingEvents.set(turnId, prevStreaming ?? []);
          }
        });
    } else if (eventType === "done" && turnId) {
      // Summary usually follows shortly. If it doesn't (e.g. no substantive
      // output), clean up streaming state after a timeout to avoid phantom turns.
      if (!doneFallbackTimers.has(turnId)) {
        const tid = turnId;
        doneFallbackTimers.set(
          tid,
          setTimeout(() => {
            doneFallbackTimers.delete(tid);
            if (streamingEvents.has(tid)) {
              streamingEvents.delete(tid);
              // Refresh the turn from the server
              fetchTurns({ mind: name, turnId: tid })
                .then((rows) => upsertTurnRows(rows))
                .catch((err) =>
                  console.warn("[TurnTimeline] Failed to refresh turn after done:", err),
                );
            }
          }, 10000),
        );
      }
    } else if (turnId && streamingEvents.has(turnId)) {
      // Substantive event — accumulate for streaming display
      // Create new array to trigger Svelte reactivity
      const prev = streamingEvents.get(turnId)!;
      streamingEvents.set(turnId, [...prev, buildHistoryMessage(d, { turn_id: turnId })]);
    }

    if (!userScrolledUp) {
      requestAnimationFrame(() => {
        scrollContainer?.scrollTo({ top: scrollContainer.scrollHeight, behavior: "smooth" });
      });
    }
  };
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      console.warn("[TurnTimeline] SSE connection closed permanently");
    } else if (es.readyState === EventSource.CONNECTING) {
      console.warn("[TurnTimeline] SSE reconnecting...");
    }
  };
  eventSource = es;
}

function disconnectSSE() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  for (const timer of doneFallbackTimers.values()) clearTimeout(timer);
  doneFallbackTimers.clear();
}

// --- Data loading ---
async function loadTurns(offset: number) {
  loading = true;
  historyError = "";
  try {
    const rows = await fetchTurns({ mind: name, limit: PAGE_SIZE, offset });
    const chronological = [...rows].reverse();
    if (offset === 0) {
      turnsData = chronological;
    } else {
      turnsData = [...chronological, ...turnsData];
    }
    hasMore = rows.length === PAGE_SIZE;

    // Check for recent untagged inbound events (message sent but turn not yet started)
    if (offset === 0 && pendingInbounds.length === 0 && name) {
      fetchHistory(name, { preset: "all", limit: 10 })
        .then((recent) => {
          const untagged = recent.filter((e) => e.type === "inbound" && !e.turn_id);
          if (untagged.length > 0 && pendingInbounds.length === 0) {
            pendingInbounds = untagged;
          }
        })
        .catch((err) => console.warn("[TurnTimeline] Failed to check pending inbounds:", err));
    }

    // Backfill streaming events for any active turns
    for (const turn of turnsData) {
      if (turn.status === "active" && !streamingEvents.has(turn.id)) {
        streamingEvents.set(turn.id, []);
        fetchTurnEvents(turn.mind, { turnId: turn.id })
          .then((dbEvents) => {
            if (!streamingEvents.has(turn.id)) return; // turn completed while fetching
            streamingEvents.set(turn.id, dbEvents);
          })
          .catch((err) =>
            console.warn("[TurnTimeline] Failed to backfill active turn events:", err),
          );
      }
    }
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
let prevName: string | undefined = "";
$effect(() => {
  const n = name;
  if (n !== prevName) {
    prevName = n;
    turnsData = [];
    hasMore = true;
    streamingEvents = new SvelteMap();
    nextSyntheticId = -1;
    pendingInbounds = [];
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

<div class="turn-timeline">
  <div class="turn-scroll" bind:this={scrollContainer} onscroll={handleScroll} onwheel={() => stopScrollTimer()}>
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
    {:else if turnsData.length === 0 && !loading}
      <div class="empty-hint">No activity yet.</div>
    {:else}
      <div class="turn-track">
        {#each turnsData as turn (turn.id)}
          <div class="turn-row" data-turn-id={turn.id}>
            <div class="turn-time">
              {#if !name}
                <button class="mind-badge" onclick={() => navigate(`/minds/${turn.mind}/history`)}>{turn.mind}</button>
              {/if}
              {formatRelativeTime(turn.created_at)}
            </div>
            <button
              aria-label="Toggle turn details"
              class="turn-rail"
              class:turn-rail-expanded={expandedTurns.has(turn.id)}
              onclick={(e) => {
                if (!turn.summary) return;
                e.stopPropagation();
                const rowEl = (e.currentTarget as HTMLElement).closest('.turn-row');
                const summaryEl = rowEl?.querySelector(':scope > .turn-body > .turn-summary > .event');
                if (summaryEl) (summaryEl as HTMLElement).click();
              }}
            >
              <div class="turn-dot"></div>
            </button>
            <div class="turn-body">
              <div class="turn-summary">
                {#if turn.summary}
                  <HistoryEvent
                    event={{
                      id: 0,
                      mind: turn.mind,
                      channel: "",
                      session: null,
                      sender: null,
                      message_id: null,
                      type: "summary",
                      content: turn.summary,
                      metadata: turn.summary_meta ? JSON.stringify(turn.summary_meta) : null,
                      turn_id: turn.id,
                      created_at: turn.created_at,
                    }}
                    mindName={turn.mind}
                    expandable
                    compact
                    turnConversations={turn.conversations}
                    turnActivities={turn.activities}
                    onexpand={(expanded) => handleExpand(turn.id, expanded)}
                  />
                {:else if turn.status === "complete"}
                  <!-- Complete but no summary (e.g. daemon restarted mid-turn) -->
                  <HistoryEvent
                    event={{
                      id: 0,
                      mind: turn.mind,
                      channel: turn.trigger?.channel ?? "",
                      session: null,
                      sender: turn.trigger?.sender ?? null,
                      message_id: null,
                      type: "summary",
                      content: turn.trigger?.content ?? "(no summary)",
                      metadata: null,
                      turn_id: turn.id,
                      created_at: turn.created_at,
                    }}
                    mindName={turn.mind}
                    expandable
                    compact
                    turnConversations={turn.conversations}
                    turnActivities={turn.activities}
                    onexpand={(expanded) => handleExpand(turn.id, expanded)}
                  />
                {:else}
                  {@const events = streamingEvents.get(turn.id) ?? []}
                  {#if events.length === 0}
                    <div class="turn-pending">processing...</div>
                  {:else}
                    {#each events as ev (ev.id)}
                      <HistoryEvent event={ev} mindName={turn.mind} compact />
                    {/each}
                  {/if}
                {/if}
              </div>
              {#if !expandedTurns.has(turn.id) && turn.status !== "active"}
              <div class="turn-cards">
                {#if !turn.summary}
                  {@const sConvs = getStreamingConversations(streamingEvents.get(turn.id) ?? [], turn.mind)}
                  {#each sConvs as conv (conv.channel)}
                    <div class="feed-card-wrapper">
                      <div class="feed-card card-chat">
                        <div class="feed-card-header header-chat">
                          <svg class="feed-card-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h12v8H5l-3 3V3z"/></svg>
                          <span class="feed-card-label">{conv.label}</span>
                          <span class="feed-card-meta">{conv.messages.length} message{conv.messages.length === 1 ? '' : 's'}</span>
                        </div>
                        <div class="feed-card-body chat-body">
                          {#each conv.messages.slice(-5) as msg, i (i)}
                            <div class="chat-entry">
                              <span class="chat-sender" class:chat-sender-user={msg.role === "user"}>{msg.sender ?? turn.mind}</span>
                              <span class="chat-entry-content">{msg.content}</span>
                            </div>
                          {/each}
                        </div>
                      </div>
                    </div>
                  {/each}
                {/if}
                {#each turn.conversations as conv (conv.id)}
                  <div class="feed-card-wrapper">
                    <div class="feed-card card-chat" role="button" tabindex="0"
                      onclick={() => openConversation(conv, turn)}
                      onkeydown={(e) => { if (e.key === 'Enter') openConversation(conv, turn); }}
                    >
                      <div class="feed-card-header header-chat">
                        <svg class="feed-card-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h12v8H5l-3 3V3z"/></svg>
                        <span class="feed-card-label">{conv.label}</span>
                        <span class="feed-card-meta">{conv.messages.length} message{conv.messages.length === 1 ? '' : 's'}</span>
                      </div>
                      <div class="feed-card-body chat-body">
                        {#each conv.messages.slice(-5) as msg (msg.id)}
                          <div class="chat-entry">
                            <span class="chat-sender" class:chat-sender-user={msg.role === "user"}>{msg.sender_name ?? (msg.role === "user" ? "user" : turn.mind)}</span>
                            <span class="chat-entry-content">{extractTextContent(msg.content)}</span>
                          </div>
                        {/each}
                      </div>
                    </div>
                  </div>
                {/each}
                {#each turn.activities as act (act.id)}
                  {@const actAuthor = typeof act.metadata?.author === 'string' ? act.metadata.author : turn.mind}
                  {@const actUrl = act.metadata?.slug ? `/minds/${actAuthor}/notes/${act.metadata.slug}` : ''}
                  <div class="feed-card-wrapper">
                    <ExtensionFeedCard
                      title={act.summary}
                      url={actUrl}
                      date={act.created_at}
                      author={actAuthor}
                      bodyHtml={typeof act.metadata?.bodyHtml === 'string' ? act.metadata.bodyHtml : ''}
                      iframeUrl={typeof act.metadata?.iframeUrl === 'string' ? act.metadata.iframeUrl : undefined}
                      icon='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2h6l4 4v8H4V2z"/><path d="M10 2v4h4"/><path d="M6 9h6M6 12h4"/></svg>'
                      color={act.type === 'page_updated' ? 'purple' : 'yellow'}
                      onclick={actUrl ? () => navigate(actUrl) : undefined}
                    />
                  </div>
                {/each}
              </div>
              {/if}
            </div>
          </div>
        {/each}
        {#if pendingInbounds.length > 0}
          <div class="turn-row">
            <div class="turn-time">
              just now
            </div>
            <div class="turn-rail">
              <div class="turn-dot"></div>
            </div>
            <div class="turn-body">
              <div class="turn-summary">
                {#each pendingInbounds as ev (ev.id)}
                  <HistoryEvent event={ev} mindName={ev.mind || name || ""} compact />
                {/each}
              </div>
            </div>
          </div>
        {/if}
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
</div>

{#if readOnlyConv}
  <ReadOnlyChatModal
    mindName={readOnlyConv.mind_name ?? name ?? ""}
    conversation={readOnlyConv}
    canChat={false}
    onClose={() => { readOnlyConv = null; }}
  />
{/if}

<style>
  .turn-timeline {
    container-type: inline-size;
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    overflow: hidden;
  }

  .turn-scroll {
    flex: 1;
    overflow-x: hidden;
    overflow-y: auto;
    padding: 0 16px;
  }

  .turn-track {
    position: relative;
    min-height: 100%;
    max-width: 1100px;
    margin: 0 auto;
  }

  .turn-row {
    display: flex;
    align-items: flex-start;
  }

  .turn-time {
    width: 60px;
    flex-shrink: 0;
    font-size: 11px;
    color: var(--text-2);
    padding-top: 10px;
    text-align: right;
    padding-right: 8px;
    white-space: nowrap;
  }

  .mind-badge {
    display: block;
    background: none;
    border: none;
    padding: 0;
    font-size: 11px;
    font-weight: 600;
    color: var(--accent);
    cursor: pointer;
    text-align: right;
  }

  .mind-badge:hover {
    text-decoration: underline;
  }

  .turn-rail {
    width: 2px;
    background: var(--timeline-rail);
    flex-shrink: 0;
    align-self: stretch;
    position: relative;
    min-height: 8px;
    overflow: visible;
    border: none;
    padding: 0;
    cursor: pointer;
  }

  .turn-rail-expanded {
    background:
      /* Solid segment at top (dot to connector) */
      linear-gradient(to bottom, var(--timeline-rail) 15px, transparent 15px),
      /* Solid segment at bottom (return line to next dot) */
      linear-gradient(to top, var(--timeline-rail) 15px, transparent 15px),
      /* Dashed middle (branch area) */
      repeating-linear-gradient(
        to bottom,
        var(--timeline-rail) 0px,
        var(--timeline-rail) 4px,
        transparent 4px,
        transparent 8px
      );
  }

  /* Suppress top-level HistoryEvent's rail pseudo-element — handled by .turn-rail.
     Only target the direct summary event, not nested events in expanded turns. */
  .turn-summary > :global(.event::after) {
    display: none;
  }
  /* Hide top-level HistoryEvent's marker dot — .turn-dot handles this on the main rail */
  .turn-summary > :global(.event > .marker) {
    display: none;
  }

  /* Highlight main rail on hover — offset to align with dot position */
  .turn-rail::before {
    content: "";
    position: absolute;
    top: 15px;
    bottom: -15px;
    left: 50%;
    width: 2px;
    margin-left: -1px;
    background: var(--text-2);
    opacity: 0;
    transition: opacity 0.15s;
    z-index: 2;
    pointer-events: none;
  }
  /* Collapsed: highlight on row hover or direct rail hover */
  .turn-row:hover > .turn-rail:not(.turn-rail-expanded)::before,
  .turn-rail:not(.turn-rail-expanded):hover::before {
    opacity: 1;
  }
  /* Expanded: highlight only on direct rail hover, matching solid-dashed-solid.
     ::before starts at top:15px (dot center) so no solid top needed.
     Solid bottom covers 30px (15px rail solid + 15px extension to next dot). */
  .turn-rail-expanded::before {
    background:
      linear-gradient(to top, var(--text-2) 30px, transparent 30px),
      repeating-linear-gradient(
        to bottom,
        var(--text-2) 0px,
        var(--text-2) 4px,
        transparent 4px,
        transparent 8px
      );
  }
  .turn-rail-expanded:hover::before {
    opacity: 1;
  }
  /* Wider invisible click/hover target for the rail */
  .turn-rail::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: -9px;
    right: -9px;
    cursor: pointer;
  }

  /* Extend HistoryEvent connectors to bridge the .turn-body padding gap */
  .turn-summary :global(.turn-connector::after) {
    left: -35px;
    width: 35px;
  }
  .turn-summary :global(.branch-return) {
    left: -28px;
    width: 36px;
  }

  .turn-dot {
    position: absolute;
    top: 12px;
    right: -2px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-2);
    z-index: 3;
  }

  /* Lower inner rail z-index so it doesn't cover the main rail dot */
  .turn-summary :global(.turn-connector) {
    z-index: 0;
  }

  .turn-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-left: 12px;
    padding-right: 12px;
  }

  .turn-summary {
    min-width: 0;
  }

  @container (max-width: 400px) {
    .turn-time {
      display: none;
    }
    .turn-body {
      padding-left: 8px;
      padding-right: 4px;
    }
    .turn-scroll {
      padding: 0 8px;
    }
    /* Shorter connector extensions for reduced padding */
    .turn-summary :global(.turn-connector::after) {
      left: -31px;
      width: 31px;
    }
    .turn-summary :global(.branch-return) {
      left: -24px;
      width: 32px;
    }
  }

  @container (min-width: 600px) {
    .turn-body {
      flex-direction: row;
    }
    .turn-summary {
      flex: 1 1 300px;
      min-width: 200px;
    }
    .turn-cards {
      flex: 0 1 360px;
      min-width: 240px;
    }
  }

  /* Feed cards */
  .feed-card-wrapper {
    padding: 4px 0;
  }

  .feed-card {
    background: var(--bg-0);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    display: flex;
    flex-direction: column;
    max-height: 200px;
    overflow: hidden;
    transition: border-color 0.15s;
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

  /* Controls */
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
</style>
