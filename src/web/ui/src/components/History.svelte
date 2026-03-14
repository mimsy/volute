<script lang="ts">
import type { HistoryMessage, HistorySession } from "@volute/api";
import { fetchHistory, fetchHistoryChannels, fetchHistorySessions } from "../lib/client";
import HistoryEvent from "./HistoryEvent.svelte";
import HistoryFilters, { type FilterState } from "./HistoryFilters.svelte";
import SessionDivider from "./SessionDivider.svelte";

let { name }: { name: string } = $props();

const PRESET_TYPES: Record<FilterState["preset"], Set<string> | null> = {
  all: null,
  summary: new Set(["summary"]),
  conversation: new Set(["summary", "inbound", "outbound", "tool_use"]),
  detailed: new Set([
    "summary",
    "inbound",
    "outbound",
    "tool_use",
    "tool_result",
    "text",
    "thinking",
  ]),
};

function matchesPreset(type: string, preset: FilterState["preset"]): boolean {
  const allowed = PRESET_TYPES[preset];
  return allowed === null || allowed.has(type);
}

const PAGE_SIZE = 100;

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
  preset: "summary",
});

let scrollContainer: HTMLDivElement | undefined = $state();
let userScrolledUp = $state(false);
let eventSource: EventSource | null = null;
let nextSseId = -1;

// Summary mode: group messages by session, sorted by most recent event timestamp
type SessionGroup = { session: string; events: HistoryMessage[] };

let sessionGroups = $derived.by(() => {
  if (filters.preset !== "summary") return [];
  const groups = new Map<string, HistoryMessage[]>();
  for (const m of messages) {
    const key = m.session ?? "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }
  const result: SessionGroup[] = [];
  for (const [session, events] of groups) {
    result.push({ session, events });
  }
  // Sort by most recent event timestamp ascending (most recent group last, at bottom)
  result.sort((a, b) => {
    const aTime = a.events[a.events.length - 1]?.created_at ?? "";
    const bTime = b.events[b.events.length - 1]?.created_at ?? "";
    return aTime < bTime ? -1 : aTime > bTime ? 1 : 0;
  });
  return result;
});

// Non-summary mode: build timeline with session dividers
type TimelineItem =
  | { kind: "divider"; session: HistorySession; key: string }
  | { kind: "event"; event: HistoryMessage; key: string };

let timeline = $derived.by(() => {
  if (filters.preset === "summary") return [];
  const items: TimelineItem[] = [];
  let lastSession: string | null = null;
  let divIdx = 0;

  for (const ev of messages) {
    if (ev.session && ev.session !== lastSession) {
      const sess = sessionMap.get(ev.session);
      if (sess) {
        items.push({ kind: "divider", session: sess, key: `div-${divIdx++}` });
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
      preset: filters.preset,
      limit: PAGE_SIZE,
      offset,
    });
    // API returns DESC -- reverse for chronological
    const chronological = [...rows].reverse();
    if (offset === 0) {
      messages = chronological;
    } else {
      // Prepend older messages
      messages = [...chronological, ...messages];
    }
    hasMore = rows.length === PAGE_SIZE;
    if (offset === 0) {
      requestAnimationFrame(() => {
        scrollContainer?.scrollTo({ top: scrollContainer.scrollHeight });
      });
    }
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
  } catch (err) {
    console.warn("[History] failed to load filter metadata:", err);
  }
}

// Reload when name, channel, session, or preset filter changes
let prevName = "";
let prevChannel = "";
let prevSession = "";
let prevPreset = "";
$effect(() => {
  const n = name;
  const ch = filters.channel;
  const sess = filters.session;
  const preset = filters.preset;
  if (n !== prevName || ch !== prevChannel || sess !== prevSession || preset !== prevPreset) {
    if (n !== prevName) {
      // Mind changed -- reset filters and metadata
      filters = { channel: "", session: "", preset: "summary" };
      channels = [];
      sessions = [];
      sessionMap = new Map();
      messages = [];
      hasMore = true;
      nextSseId = -1;
      loadMeta();
    }
    prevName = n;
    prevChannel = ch;
    prevSession = sess;
    prevPreset = preset;
    load(0);
  }
});

// SSE live mode -- always on.
// Reads filters.channel/session inside connectSSE(), so Svelte re-runs on filter changes.
$effect(() => {
  connectSSE();
  return () => disconnectSSE();
});

function connectSSE() {
  disconnectSSE();
  const params = new URLSearchParams();
  if (filters.channel) params.set("channel", filters.channel);
  if (filters.session) params.set("session", filters.session);
  const qs = params.toString();
  const url = `/api/minds/${encodeURIComponent(name)}/events${qs ? `?${qs}` : ""}`;

  const currentPreset = filters.preset;

  const es = new EventSource(url);
  es.onmessage = (e) => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }

    const event: HistoryMessage = {
      id: nextSseId--,
      mind: name,
      channel: (data.channel as string) ?? "",
      session: (data.session as string) ?? null,
      sender: null,
      message_id: (data.messageId as string) ?? null,
      type: data.type as string,
      content: (data.content as string) ?? "",
      metadata: data.metadata ? JSON.stringify(data.metadata) : null,
      created_at: (data.createdAt as string) ?? new Date().toISOString(),
    };

    // Filter SSE events by current preset
    if (!matchesPreset(event.type, currentPreset)) return;

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
  };
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      console.warn("[History] SSE connection closed by server");
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

function handleSessionClick(session: string) {
  filters = { ...filters, session };
}
</script>

<div class="history">
  <div class="filter-float">
    <HistoryFilters
      {channels}
      {sessions}
      {filters}
      onchange={handleFilterChange}
    />
  </div>

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
    {:else if messages.length === 0 && !loading}
      <div class="empty">No events found.</div>
    {/if}

    {#if filters.preset === 'summary'}
      <div class="timeline-rail">
        {#each sessionGroups as group (group.session)}
          <div class="session-section">
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="session-divider" onclick={() => handleSessionClick(group.session)}>
              <div class="session-divider-line line-left"></div>
              <span class="session-divider-label">{group.session || "no session"}</span>
              <div class="session-divider-line"></div>
            </div>
            {#each group.events as ev (ev.id)}
              <HistoryEvent event={ev} mindName={name} expandable onsessionclick={handleSessionClick} />
            {/each}
          </div>
        {/each}
      </div>
    {:else}
      <div class="timeline-rail">
        {#each timeline as item (item.key)}
          {#if item.kind === "divider"}
            <SessionDivider
              session={item.session.session}
              startedAt={item.session.started_at}
            />
          {:else}
            <HistoryEvent event={item.event} mindName={name} />
          {/if}
        {/each}
      </div>
    {/if}

    {#if loading && messages.length > 0}
      <div class="loading-more">loading...</div>
    {/if}
  </div>

  {#if userScrolledUp}
    <button class="jump-btn" onclick={jumpToLatest}>
      jump to latest
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

  .filter-float {
    position: absolute;
    top: 4px;
    right: 4px;
    z-index: 10;
  }

  .timeline {
    flex: 1;
    overflow-x: hidden;
    overflow-y: auto;
  }

  .timeline-rail {
    position: relative;
    padding-left: 4px;
    margin-left: 3px;
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

  .session-divider {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 8px 8px 8px;
    cursor: pointer;
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
    transition: color 0.15s;
  }
  .session-divider:hover .session-divider-label {
    color: var(--text-1);
  }

  .session-section {
    position: relative;
  }
  /* Highlight whole track section on session header hover */
  .session-section::after {
    content: "";
    position: absolute;
    left: -2px;
    top: -4px;
    bottom: -4px;
    width: 2px;
    background: var(--text-2);
    opacity: 0;
    transition: opacity 0.15s;
    z-index: 0;
  }
  .session-section:has(> .session-divider:hover)::after {
    opacity: 1;
  }

  .error {
    color: var(--red);
    text-align: center;
    padding: 40px;
    font-size: 14px;
  }

  .empty {
    color: var(--text-2);
    text-align: center;
    padding: 40px;
    font-size: 14px;
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
</style>
