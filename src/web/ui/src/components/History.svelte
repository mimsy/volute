<script lang="ts">
import {
  fetchHistory,
  fetchHistoryChannels,
  fetchHistorySessions,
  type HistoryMessage,
  type HistorySession,
} from "../lib/api";
import HistoryEvent from "./HistoryEvent.svelte";
import HistoryFilters, { type FilterState } from "./HistoryFilters.svelte";
import SessionDivider from "./SessionDivider.svelte";

let { name }: { name: string } = $props();

const PAGE_SIZE = 100;
const ALL_TYPES = new Set([
  "inbound",
  "outbound",
  "tool_use",
  "tool_result",
  "thinking",
  "usage",
  "log",
]);

let messages = $state<HistoryMessage[]>([]);
let channels = $state<string[]>([]);
let sessions = $state<HistorySession[]>([]);
let sessionMap = $state<Map<string, HistorySession>>(new Map());
let hasMore = $state(true);
let loading = $state(false);
let error = $state("");
let filters = $state<FilterState>({
  channel: "",
  session: "",
  types: new Set(ALL_TYPES),
  live: false,
});

let scrollContainer: HTMLDivElement | undefined = $state();
let userScrolledUp = $state(false);
let eventSource: EventSource | null = $state(null);

// Filtered messages (type filter is client-side)
let filtered = $derived(messages.filter((m) => filters.types.has(m.type)));

// Build session groups for dividers
type TimelineItem =
  | { kind: "divider"; session: HistorySession; key: string }
  | { kind: "event"; event: HistoryMessage; key: string };

let timeline = $derived.by(() => {
  const items: TimelineItem[] = [];
  let lastSession: string | null = null;

  for (const ev of filtered) {
    if (ev.session && ev.session !== lastSession) {
      const sess = sessionMap.get(ev.session);
      if (sess) {
        items.push({ kind: "divider", session: sess, key: `div-${ev.session}` });
      }
      lastSession = ev.session;
    }
    items.push({ kind: "event", event: ev, key: `ev-${ev.id}` });
  }

  return items;
});

async function load(offset: number) {
  loading = true;
  error = "";
  try {
    const rows = await fetchHistory(name, {
      channel: filters.channel || undefined,
      session: filters.session || undefined,
      full: true,
      limit: PAGE_SIZE,
      offset,
    });
    // API returns DESC — reverse for chronological
    const chronological = [...rows].reverse();
    if (offset === 0) {
      messages = chronological;
    } else {
      // Prepend older messages
      messages = [...chronological, ...messages];
    }
    hasMore = rows.length === PAGE_SIZE;
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load history";
  }
  loading = false;
}

async function loadMeta() {
  try {
    const [ch, sess] = await Promise.all([fetchHistoryChannels(name), fetchHistorySessions(name)]);
    channels = ch;
    sessions = sess;
    sessionMap = new Map(sess.map((s) => [s.session, s]));
  } catch {
    // Non-critical
  }
}

// Initial load
$effect(() => {
  loadMeta();
  load(0);
});

// Reload when channel or session filter changes
let prevChannel = "";
let prevSession = "";
$effect(() => {
  const ch = filters.channel;
  const sess = filters.session;
  if (ch !== prevChannel || sess !== prevSession) {
    prevChannel = ch;
    prevSession = sess;
    load(0);
  }
});

// SSE live mode
$effect(() => {
  if (filters.live) {
    connectSSE();
  } else {
    disconnectSSE();
  }
  return () => disconnectSSE();
});

function connectSSE() {
  disconnectSSE();
  const params = new URLSearchParams();
  if (filters.channel) params.set("channel", filters.channel);
  if (filters.session) params.set("session", filters.session);
  const qs = params.toString();
  const url = `/api/minds/${encodeURIComponent(name)}/events${qs ? `?${qs}` : ""}`;

  const es = new EventSource(url);
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      const event: HistoryMessage = {
        id: Date.now(),
        mind: name,
        channel: data.channel ?? "",
        session: data.session ?? null,
        sender: null,
        message_id: data.messageId ?? null,
        type: data.type,
        content: data.content ?? "",
        metadata: data.metadata ? JSON.stringify(data.metadata) : null,
        created_at: data.createdAt ?? new Date().toISOString(),
      };
      messages = [...messages, event];

      // Update session map if new session
      if (event.session && !sessionMap.has(event.session)) {
        const newSess: HistorySession = {
          session: event.session,
          started_at: event.created_at,
          event_count: 1,
          message_count: ["inbound", "outbound"].includes(event.type) ? 1 : 0,
          tool_count: event.type === "tool_use" ? 1 : 0,
        };
        sessionMap = new Map([...sessionMap, [event.session, newSess]]);
        sessions = [newSess, ...sessions];
      }

      // Auto-scroll if user is near bottom
      if (!userScrolledUp) {
        requestAnimationFrame(() => {
          scrollContainer?.scrollTo({ top: scrollContainer.scrollHeight, behavior: "smooth" });
        });
      }
    } catch {
      // Ignore unparseable events
    }
  };
  es.onerror = () => {
    // Will auto-reconnect
  };
  eventSource = es;
}

function disconnectSSE() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function handleScroll() {
  if (!scrollContainer) return;
  const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
  userScrolledUp = scrollHeight - scrollTop - clientHeight > 100;
}

function jumpToLatest() {
  scrollContainer?.scrollTo({ top: scrollContainer.scrollHeight, behavior: "smooth" });
  userScrolledUp = false;
}

function handleFilterChange(next: FilterState) {
  filters = next;
}
</script>

<div class="history">
  <HistoryFilters
    {channels}
    {sessions}
    {filters}
    onchange={handleFilterChange}
  />

  <div class="timeline" bind:this={scrollContainer} onscroll={handleScroll}>
    {#if hasMore}
      <div class="load-older">
        <button
          onclick={() => load(messages.length)}
          disabled={loading}
          class="load-older-btn"
          style:opacity={loading ? 0.5 : 1}
        >
          {loading ? "loading..." : "load older"}
        </button>
      </div>
    {/if}

    {#if error}
      <div class="error">{error}</div>
    {:else if filtered.length === 0 && !loading}
      <div class="empty">No events found.</div>
    {/if}

    <div class="timeline-rail">
      {#each timeline as item (item.key)}
        {#if item.kind === "divider"}
          <SessionDivider
            session={item.session.session}
            startedAt={item.session.started_at}
            eventCount={item.session.event_count}
            messageCount={item.session.message_count}
            toolCount={item.session.tool_count}
          />
        {:else}
          <HistoryEvent event={item.event} mindName={name} />
        {/if}
      {/each}
    </div>

    {#if loading && messages.length > 0}
      <div class="loading-more">loading...</div>
    {/if}
  </div>

  {#if userScrolledUp && filters.live}
    <button class="jump-btn" onclick={jumpToLatest}>
      ↓ jump to latest
    </button>
  {/if}
</div>

<style>
  .history {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    position: relative;
  }

  .timeline {
    flex: 1;
    overflow: auto;
    padding-top: 8px;
  }

  .timeline-rail {
    position: relative;
    padding-left: 4px;
    border-left: 1px solid var(--border);
    margin-left: 3px;
  }

  .error {
    color: var(--red);
    text-align: center;
    padding: 40px;
    font-size: 13px;
  }

  .empty {
    color: var(--text-2);
    text-align: center;
    padding: 40px;
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
    font-size: 11px;
  }

  .loading-more {
    text-align: center;
    color: var(--text-2);
    font-size: 12px;
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
    font-size: 12px;
    animation: fadeIn 0.2s ease both;
    z-index: 10;
  }
</style>
