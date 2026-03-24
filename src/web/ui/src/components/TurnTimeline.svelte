<script lang="ts">
import type {
  ConversationWithParticipants,
  HistoryMessage,
  SummaryRow,
  TurnConversation,
  TurnRow,
} from "@volute/api";
import { Icon } from "@volute/ui";
import { renderMarkdown } from "@volute/ui/markdown";
import { SvelteMap } from "svelte/reactivity";
import {
  fetchHistory,
  fetchSummaries,
  fetchSummaryByIds,
  fetchTurnEvents,
  fetchTurns,
} from "../lib/client";
import { extractTextContent } from "../lib/feed-utils";
import { formatRelativeTime } from "../lib/format";
import { navigate } from "../lib/navigate";
import { activeMinds } from "../lib/stores.svelte";
import { groupToolEvents } from "../lib/tool-groups";
import { getCategoryColor, getCategoryIcon } from "../lib/tool-names";
import ToolGroupComponent from "./chat/ToolGroup.svelte";
import HistoryEvent from "./HistoryEvent.svelte";
import ReadOnlyChatModal from "./modals/ReadOnlyChatModal.svelte";

type TimelineItem =
  | { kind: "turn"; turn: TurnRow }
  | { kind: "summary"; summary: SummaryRow }
  | { kind: "separator"; above: string; below: string };

type SummaryPeriod = "hour" | "day" | "week" | "month";

const CHILD_PERIOD: Record<string, SummaryPeriod | "turn"> = {
  hour: "turn",
  day: "hour",
  week: "day",
  month: "week",
};

function parseISOWeek(weekKey: string): Date {
  // weekKey format: "2026-W12" — returns the Monday of that week (local time)
  const [yearStr, weekStr] = weekKey.split("-W");
  const year = parseInt(yearStr, 10);
  const week = parseInt(weekStr, 10);
  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = jan4.getDay() || 7;
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - dayOfWeek + 1 + (week - 1) * 7);
  return monday;
}

// Period keys are local time. Parse without Z suffix.
function periodKeyToDate(period: string, periodKey: string): Date {
  if (period === "hour")
    return new Date(`${periodKey.slice(0, 10)}T${periodKey.slice(11, 13)}:00:00`);
  if (period === "day") return new Date(`${periodKey}T00:00:00`);
  if (period === "week") return parseISOWeek(periodKey);
  if (period === "month") return new Date(`${periodKey}-01T00:00:00`);
  return new Date(periodKey);
}

function formatPeriodTime(period: string, periodKey: string): string {
  const now = new Date();
  const todayLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayLocal = new Date(todayLocal);
  yesterdayLocal.setDate(todayLocal.getDate() - 1);

  if (period === "hour") {
    // Period keys are local time — parse directly
    const start = periodKeyToDate("hour", periodKey);
    const end = new Date(start.getTime() + 3600000);

    const fmtTime = (d: Date) =>
      d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

    const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const isToday = startDay.getTime() === todayLocal.getTime();
    if (isToday) {
      return `${fmtTime(start)} \u2013 ${fmtTime(end)}`;
    }
    const monthDay = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `${monthDay}, ${fmtTime(start)} \u2013 ${fmtTime(end)}`;
  }

  if (period === "day") {
    // Period keys are local dates — direct comparison
    const d = periodKeyToDate("day", periodKey);
    if (d.getTime() === todayLocal.getTime()) return "Today";
    if (d.getTime() === yesterdayLocal.getTime()) return "Yesterday";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  if (period === "week") {
    const start = parseISOWeek(periodKey);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    const fmtDate = (d: Date) =>
      d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    if (start.getFullYear() !== now.getFullYear()) {
      return `${fmtDate(start)} \u2013 ${fmtDate(end)}, ${start.getFullYear()}`;
    }
    return `${fmtDate(start)} \u2013 ${fmtDate(end)}`;
  }

  if (period === "month") {
    const [year, month] = periodKey.split("-");
    const d = new Date(parseInt(year, 10), parseInt(month, 10) - 1, 1);
    return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }

  return periodKey;
}

function periodEndDate(period: string, periodKey: string): Date {
  if (period === "hour") {
    const d = periodKeyToDate(period, periodKey);
    d.setHours(d.getHours() + 1);
    return d;
  }
  if (period === "day") {
    const d = periodKeyToDate(period, periodKey);
    d.setDate(d.getDate() + 1);
    return d;
  }
  if (period === "week") {
    const monday = parseISOWeek(periodKey);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 7);
    return sunday;
  }
  if (period === "month") {
    const d = periodKeyToDate(period, periodKey);
    d.setMonth(d.getMonth() + 1);
    return d;
  }
  return new Date(periodKey);
}

let { name, mindStatus }: { name?: string; mindStatus?: string } = $props();

// --- Turns data ---
const PAGE_SIZE = 100;
let turnsData = $state<TurnRow[]>([]);
let hasMore = $state(true);
let loading = $state(false);
let historyError = $state("");

let readOnlyConv = $state<ConversationWithParticipants | null>(null);

// --- Summaries data ---
let hourSummaries = $state<SummaryRow[]>([]);
let daySummaries = $state<SummaryRow[]>([]);
let weekSummaries = $state<SummaryRow[]>([]);
let monthSummaries = $state<SummaryRow[]>([]);
let summariesLoaded = $state(false);
let expandedSummaries = $state(new SvelteMap<number, SummaryRow[] | TurnRow[]>());
let loadingChildren = $state(new Set<number>());
// For single-turn hours: expand directly to raw events instead of showing the turn summary
let directEventsSummaries = $state(new SvelteMap<number, HistoryMessage[]>());

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

async function loadSummaries() {
  try {
    const now = new Date();

    // Period keys are local time. Build boundaries directly.
    const pad2 = (n: number) => String(n).padStart(2, "0");
    const todayKey = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    const hourCutoff = `${todayKey}T${pad2(now.getHours())}`;
    const todayHourFrom = `${todayKey}T00`;
    const todayDayKey = todayKey;

    // Week boundary (7 days ago)
    const weekAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
    const weekCutoff = `${weekAgo.getFullYear()}-${pad2(weekAgo.getMonth() + 1)}-${pad2(weekAgo.getDate())}`;

    // Load hours for today (from local start-of-day to current hour, in UTC keys)
    const hours = await fetchSummaries({
      mind: name,
      period: "hour",
      from: todayHourFrom,
      to: hourCutoff,
      limit: 24,
    });
    hourSummaries = hours.sort((a, b) => a.period_key.localeCompare(b.period_key));

    // Load days for last week (before today's day key)
    const days = await fetchSummaries({
      mind: name,
      period: "day",
      from: weekCutoff,
      to: todayDayKey,
      limit: 7,
    });
    // Exclude today — it's covered by hourly summaries
    daySummaries = days
      .filter((d) => d.period_key < todayDayKey)
      .sort((a, b) => a.period_key.localeCompare(b.period_key));

    // Load weeks (before last week). Exclude current week.
    const weeks = await fetchSummaries({ mind: name, period: "week", to: weekCutoff, limit: 12 });
    weekSummaries = weeks.sort((a, b) => a.period_key.localeCompare(b.period_key));

    // Load months (exclude current month — it's still in progress)
    const currentMonth = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
    const months = await fetchSummaries({
      mind: name,
      period: "month",
      to: currentMonth,
      limit: 12,
    });
    // Filter out the current month in case the boundary comparison includes it
    monthSummaries = months
      .filter((m) => m.period_key < currentMonth)
      .sort((a, b) => a.period_key.localeCompare(b.period_key));

    summariesLoaded = true;
  } catch (e) {
    console.warn("[TurnTimeline] Failed to load summaries:", e);
    summariesLoaded = true; // still mark loaded so we don't block the UI
  }
}

async function toggleSummaryExpand(summary: SummaryRow) {
  if (expandedSummaries.has(summary.id) || directEventsSummaries.has(summary.id)) {
    expandedSummaries.delete(summary.id);
    directEventsSummaries.delete(summary.id);
    expandedSummaries = new SvelteMap(expandedSummaries);
    directEventsSummaries = new SvelteMap(directEventsSummaries);
    return;
  }

  loadingChildren.add(summary.id);
  loadingChildren = new Set(loadingChildren);

  try {
    const childPeriod = CHILD_PERIOD[summary.period];

    if (childPeriod === "turn") {
      // Fetch child turn summaries by their IDs (stored in metadata.source_ids),
      // then use their period_key (= turn UUID) to fetch full turn rows.
      const sourceIds: number[] =
        ((summary.metadata as Record<string, unknown>)?.source_ids as number[]) ?? [];

      if (sourceIds.length > 0) {
        const turnSummaryRows = await fetchSummaryByIds(sourceIds);
        const turnIds = turnSummaryRows.map((s) => s.period_key);

        if (turnIds.length === 1) {
          const events = await fetchTurnEvents(turnSummaryRows[0].mind, {
            turnId: turnIds[0],
          });
          directEventsSummaries.set(summary.id, events);
          directEventsSummaries = new SvelteMap(directEventsSummaries);
        } else if (turnIds.length > 0) {
          const turns: TurnRow[] = [];
          for (const tid of turnIds) {
            const rows = await fetchTurns({ turnId: tid });
            turns.push(...rows);
          }
          turns.sort((a, b) => a.created_at.localeCompare(b.created_at));
          expandedSummaries.set(summary.id, turns);
          expandedSummaries = new SvelteMap(expandedSummaries);
        } else {
          expandedSummaries.set(summary.id, []);
          expandedSummaries = new SvelteMap(expandedSummaries);
        }
      } else {
        expandedSummaries.set(summary.id, []);
        expandedSummaries = new SvelteMap(expandedSummaries);
      }
    } else {
      // For summary children, use period_key-format boundaries (not ISO timestamps)
      // to avoid string comparison issues with colons in ISO strings.
      let from: string;
      let to: string;
      if (summary.period === "day") {
        // Day "2026-03-19" → hours with keys starting with "2026-03-19"
        from = summary.period_key;
        to = `${summary.period_key}T99`; // all hours within this date
      } else if (summary.period === "week") {
        // Week → days within the week's date range
        const monday = parseISOWeek(summary.period_key);
        const sunday = new Date(monday);
        sunday.setUTCDate(monday.getUTCDate() + 6);
        from = monday.toISOString().slice(0, 10);
        to = sunday.toISOString().slice(0, 10);
      } else if (summary.period === "month") {
        // Month "2026-03" → weeks/days within
        from = `${summary.period_key}-01`;
        to = `${summary.period_key}-31`;
      } else {
        from = summary.period_key;
        to = summary.period_key;
      }

      const children = await fetchSummaries({
        mind: name,
        period: childPeriod,
        from,
        to,
        limit: 100,
      });
      expandedSummaries.set(
        summary.id,
        children.sort((a, b) => a.period_key.localeCompare(b.period_key)),
      );
    }
    expandedSummaries = new SvelteMap(expandedSummaries);
  } catch (e) {
    console.warn("[TurnTimeline] Failed to load summary children:", e);
  }

  loadingChildren.delete(summary.id);
  loadingChildren = new Set(loadingChildren);
}

// Build the combined timeline items list
let timelineItems = $derived.by(() => {
  const items: TimelineItem[] = [];
  const now = new Date();

  // Turns from the current hour onward are shown individually;
  // older turns are covered by hourly summaries
  const currentHourStart = new Date(now);
  currentHourStart.setUTCMinutes(0, 0, 0);
  const hourCutoffMs = currentHourStart.getTime();

  // But also include any turns from today that don't have an hourly summary yet
  // (i.e., turns from the current in-progress hour)

  // Monthly summaries (oldest)
  for (const s of monthSummaries) items.push({ kind: "summary", summary: s });

  // Weekly summaries
  for (const s of weekSummaries) items.push({ kind: "summary", summary: s });

  // Separator if transitioning from week/month to day level
  if ((monthSummaries.length > 0 || weekSummaries.length > 0) && daySummaries.length > 0) {
    const aboveLabel = weekSummaries.length > 0 ? "earlier" : "earlier";
    items.push({ kind: "separator", above: aboveLabel, below: "this week" });
  }

  // Daily summaries
  for (const s of daySummaries) items.push({ kind: "summary", summary: s });

  // Separator before hourly
  if ((daySummaries.length > 0 || items.length > 0) && hourSummaries.length > 0) {
    items.push({ kind: "separator", above: "earlier this week", below: "today" });
  }

  // Hourly summaries
  for (const s of hourSummaries) items.push({ kind: "summary", summary: s });

  // Only turns from the current hour (or active turns)
  const recentTurns = turnsData.filter((t) => {
    const turnTime = new Date(t.created_at + (t.created_at.endsWith("Z") ? "" : "Z")).getTime();
    return turnTime >= hourCutoffMs || t.status === "active" || streamingEvents.has(t.id);
  });

  // Separator before turns
  if (items.length > 0 && recentTurns.length > 0) {
    items.push({ kind: "separator", above: "earlier today", below: "this hour" });
  }

  for (const t of recentTurns) {
    items.push({ kind: "turn", turn: t });
  }

  return items;
});

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
    hourSummaries = [];
    daySummaries = [];
    weekSummaries = [];
    monthSummaries = [];
    summariesLoaded = false;
    expandedSummaries = new SvelteMap();
    directEventsSummaries = new SvelteMap();
    startScrollToBottom();
    loadTurns(0);
  }
});

// Load summaries once turns are available
$effect(() => {
  if (turnsData.length > 0 && !summariesLoaded && !loading) {
    loadSummaries();
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
    {:else if timelineItems.length === 0 && !loading}
      <div class="empty-hint">No activity yet.</div>
    {:else}
      <div class="turn-track">
        {#each timelineItems as item (item.kind === "turn" ? `turn-${item.turn.id}` : item.kind === "summary" ? `summary-${item.summary.id}` : `sep-${item.above}-${item.below}`)}
          {#if item.kind === "separator"}
            <div class="turn-row scale-break-row">
              <div class="turn-time"></div>
              <div class="scale-break-container">
                <div class="scale-break-slash"></div>
                <div class="scale-break-gap"></div>
                <div class="scale-break-slash"></div>
                <div class="scale-break-label scale-break-label-above">
                  <svg class="scale-break-arrow" viewBox="0 0 8 5"><path d="M4 0L8 5H0z" fill="currentColor"/></svg>
                  <span>{item.above}</span>
                </div>
                <div class="scale-break-label scale-break-label-below">
                  <svg class="scale-break-arrow" viewBox="0 0 8 5"><path d="M4 5L0 0h8z" fill="currentColor"/></svg>
                  <span>{item.below}</span>
                </div>
              </div>
              <div class="turn-body"></div>
            </div>
          {:else if item.kind === "summary"}
            {@const summary = item.summary}
            {@const isExpanded = expandedSummaries.has(summary.id) || directEventsSummaries.has(summary.id)}
            {@const isLoading = loadingChildren.has(summary.id)}
            {@const directEvents = directEventsSummaries.get(summary.id)}
            <div class="turn-row" data-summary-id={summary.id}>
              <div class="turn-time">
                {#if !name && summary.mind !== "_system"}
                  <button class="mind-badge" onclick={() => navigate(`/minds/${summary.mind}/history`)}>{summary.mind}</button>
                {/if}
              </div>
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="turn-rail"
                class:turn-rail-expanded={isExpanded}
                onclick={() => toggleSummaryExpand(summary)}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSummaryExpand(summary); } }}
              >
                <div class="turn-dot summary-dot"></div>
              </div>
              <div class="turn-body">
                <div class="turn-summary">
                  {#if isExpanded}
                    <div class="summary-expand-wrapper">
                      <div class="summary-expand-connector"></div>
                      <div class="summary-expand-branch">
                        <!-- svelte-ignore a11y_click_events_have_key_events -->
                        <!-- svelte-ignore a11y_no_static_element_interactions -->
                        <div class="summary-expand-header" onclick={(e) => { e.stopPropagation(); toggleSummaryExpand(summary); }}>
                          <span class="active-turn-time">{formatPeriodTime(summary.period, summary.period_key)}</span>
                        </div>
                        {#if isLoading}
                          <div class="summary-expand-loading">loading...</div>
                        {:else if directEvents}
                          {@const groups = groupToolEvents(directEvents)}
                          {#each groups as groupItem (groupItem.kind === "tool-group" ? `tg-${groupItem.toolUse.id}` : `ev-${groupItem.event.id}`)}
                            {#if groupItem.kind === "tool-group"}
                              {@const catColor = getCategoryColor(groupItem.category)}
                              {@const catIcon = getCategoryIcon(groupItem.category)}
                              <div class="event" style:--type-color={catColor}>
                                <div class="marker marker-icon" style:color={catColor}>
                                  <Icon kind={catIcon} />
                                </div>
                                <ToolGroupComponent group={groupItem} mindName={summary.mind} turnStatus="complete" />
                              </div>
                            {:else}
                              <HistoryEvent event={groupItem.event} mindName={summary.mind} />
                            {/if}
                          {/each}
                        {:else}
                          {@const children = expandedSummaries.get(summary.id) ?? []}
                          {#each children as child (('period' in child) ? `s-${child.id}` : `t-${child.id}`)}
                            {#if 'period' in child}
                              {@const childSummary = child as SummaryRow}
                              {@const childExpanded = expandedSummaries.has(childSummary.id)}
                              <!-- svelte-ignore a11y_click_events_have_key_events -->
                              <!-- svelte-ignore a11y_no_static_element_interactions -->
                              <div class="summary-child-item" class:summary-child-expanded={childExpanded} class:summary-child-collapsed={!childExpanded} onclick={(e) => { e.stopPropagation(); toggleSummaryExpand(childSummary); }}>
                                <div class="summary-child-dot" class:summary-dot={true}></div>
                                <div class="summary-child-body">
                                  {#if !childExpanded}
                                    <span class="summary-child-time">{formatPeriodTime(childSummary.period, childSummary.period_key)}</span>
                                    <span class="summary-text">{childSummary.content}</span>
                                  {/if}
                                </div>
                              </div>
                              {#if childExpanded}
                                {@const childDirectEvents = directEventsSummaries.get(childSummary.id)}
                                <div class="summary-nested-wrapper">
                                  <div class="summary-nested-connector"></div>
                                  <div class="summary-nested-branch">
                                    <!-- svelte-ignore a11y_click_events_have_key_events -->
                                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                                    <div class="summary-expand-header" onclick={(e) => { e.stopPropagation(); toggleSummaryExpand(childSummary); }}>
                                      <span class="active-turn-time">{formatPeriodTime(childSummary.period, childSummary.period_key)}</span>
                                    </div>
                                    {#if loadingChildren.has(childSummary.id)}
                                      <div class="summary-expand-loading">loading...</div>
                                    {:else if childDirectEvents}
                                      {@const groups = groupToolEvents(childDirectEvents)}
                                      {#each groups as groupItem (groupItem.kind === "tool-group" ? `tg-${groupItem.toolUse.id}` : `ev-${groupItem.event.id}`)}
                                        {#if groupItem.kind === "tool-group"}
                                          {@const catColor = getCategoryColor(groupItem.category)}
                                          {@const catIcon = getCategoryIcon(groupItem.category)}
                                          <div class="event" style:--type-color={catColor}>
                                            <div class="marker marker-icon" style:color={catColor}>
                                              <Icon kind={catIcon} />
                                            </div>
                                            <ToolGroupComponent group={groupItem} mindName={childSummary.mind} turnStatus="complete" />
                                          </div>
                                        {:else}
                                          <HistoryEvent event={groupItem.event} mindName={childSummary.mind} />
                                        {/if}
                                      {/each}
                                    {:else}
                                      {@const grandchildren = expandedSummaries.get(childSummary.id) ?? []}
                                      {#each grandchildren as gc (('period' in gc) ? `s-${gc.id}` : `t-${gc.id}`)}
                                        {#if !('period' in gc)}
                                          {@const gcTurn = gc as TurnRow}
                                          <!-- svelte-ignore a11y_click_events_have_key_events -->
                                          <!-- svelte-ignore a11y_no_static_element_interactions -->
                                          <div onclick={(e) => e.stopPropagation()}>
                                            <HistoryEvent
                                              event={{
                                                id: 0,
                                                mind: gcTurn.mind,
                                                channel: "",
                                                session: null,
                                                sender: null,
                                                message_id: null,
                                                type: "summary",
                                                content: gcTurn.summary ?? "(no summary)",
                                                metadata: gcTurn.summary_meta ? JSON.stringify(gcTurn.summary_meta) : null,
                                                turn_id: gcTurn.id,
                                                created_at: gcTurn.created_at,
                                              }}
                                              mindName={gcTurn.mind}
                                              expandable
                                            />
                                          </div>
                                        {/if}
                                      {/each}
                                    {/if}
                                    <button class="summary-expand-collapse" onclick={(e) => { e.stopPropagation(); toggleSummaryExpand(childSummary); }}>
                                      <span class="summary-text">{childSummary.content}</span>
                                    </button>
                                    <div class="summary-nested-return"></div>
                                  </div>
                                </div>
                              {/if}
                            {:else}
                              {@const childTurn = child as TurnRow}
                              <!-- svelte-ignore a11y_click_events_have_key_events -->
                              <!-- svelte-ignore a11y_no_static_element_interactions -->
                              <div onclick={(e) => e.stopPropagation()}>
                                <HistoryEvent
                                  event={{
                                    id: 0,
                                    mind: childTurn.mind,
                                    channel: "",
                                    session: null,
                                    sender: null,
                                    message_id: null,
                                    type: "summary",
                                    content: childTurn.summary ?? "(no summary)",
                                    metadata: childTurn.summary_meta ? JSON.stringify(childTurn.summary_meta) : null,
                                    turn_id: childTurn.id,
                                    created_at: childTurn.created_at,
                                  }}
                                  mindName={childTurn.mind}
                                  expandable
                                />
                              </div>
                            {/if}
                          {/each}
                        {/if}
                        <button class="summary-expand-collapse" onclick={() => toggleSummaryExpand(summary)}>
                          <span class="summary-text">{summary.content}</span>
                        </button>
                        <div class="summary-expand-return"></div>
                      </div>
                    </div>
                  {:else}
                    <!-- svelte-ignore a11y_click_events_have_key_events -->
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <div class="summary-collapsed" onclick={() => toggleSummaryExpand(summary)}>
                      <span class="summary-collapsed-time">{formatPeriodTime(summary.period, summary.period_key)}</span>
                      <span class="summary-text">{summary.content}</span>
                    </div>
                  {/if}
                </div>
              </div>
            </div>
          {:else}
            {@const turn = item.turn}
          {@const peekCount = (!expandedTurns.has(turn.id) && turn.status !== "active") ? turn.conversations.length + turn.activities.length : 0}
          <div class="turn-row" data-turn-id={turn.id} style:min-height={peekCount > 0 ? `${36 + peekCount * 48}px` : undefined}>
            <div class="turn-time">
              {#if !name}
                <button class="mind-badge" onclick={() => navigate(`/minds/${turn.mind}/history`)}>{turn.mind}</button>
              {/if}
              {formatRelativeTime(turn.created_at)}
            </div>
            <div
              class="turn-rail"
              class:turn-rail-expanded={expandedTurns.has(turn.id) || turn.status === "active"}
              role="button"
              tabindex="0"
              onclick={(e) => {
                if (!turn.summary) return;
                e.stopPropagation();
                const rowEl = (e.currentTarget as HTMLElement).closest('.turn-row');
                const summaryEl = rowEl?.querySelector(':scope > .turn-body > .turn-summary > .event');
                if (summaryEl) (summaryEl as HTMLElement).click();
              }}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); (e.currentTarget as HTMLElement).click(); } }}
            >
              <div class="turn-dot"></div>
              {#if !expandedTurns.has(turn.id) && turn.status !== "active" && (turn.conversations.length > 0 || turn.activities.length > 0)}
                <div class="turn-peek-icons">
                  {#each turn.conversations as conv (conv.id)}
                    <div class="peek-anchor">
                      <button class="peek-btn" aria-label="View conversation" onclick={(e) => e.stopPropagation()}>
                        <Icon kind="chat" />
                      </button>
                      <div class="peek-popover" role="button" tabindex="0"
                        onclick={(e) => { e.stopPropagation(); openConversation(conv, turn); }}
                        onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); openConversation(conv, turn); } }}
                      >
                        <div class="peek-card peek-card-chat">
                          <div class="peek-card-header">
                            <Icon kind="chat" class="peek-card-icon" />
                            <span class="peek-card-label">{conv.label}</span>
                            <span class="peek-card-meta">{conv.messages.length} msg{conv.messages.length === 1 ? '' : 's'}</span>
                          </div>
                          <div class="peek-card-body">
                            {#each conv.messages.slice(-5) as msg (msg.id)}
                              <div class="peek-msg">
                                <span class="peek-msg-sender" class:peek-msg-sender-user={msg.role === "user"}>{msg.sender_name ?? (msg.role === "user" ? "user" : turn.mind)}</span>
                                {#if msg.role === "assistant"}
                                  <span class="peek-msg-md markdown-body">{@html renderMarkdown(extractTextContent(msg.content))}</span>
                                {:else}
                                  <span>{extractTextContent(msg.content)}</span>
                                {/if}
                              </div>
                            {/each}
                          </div>
                        </div>
                      </div>
                    </div>
                  {/each}
                  {#each turn.activities as act (act.id)}
                    {@const actColor = typeof act.metadata?.color === 'string' ? act.metadata.color : 'yellow'}
                    {@const actIcon = typeof act.metadata?.icon === 'string' ? act.metadata.icon : ''}
                    {@const actUrl = typeof act.metadata?.iframeUrl === 'string' ? act.metadata.iframeUrl : typeof act.metadata?.slug === 'string' ? `/minds/${typeof act.metadata?.author === 'string' ? act.metadata.author : turn.mind}/notes/${act.metadata.slug}` : ''}
                    <div class="peek-anchor">
                      <button class="peek-btn" style:color="var(--{actColor})" aria-label="View activity" onclick={(e) => { e.stopPropagation(); if (actUrl) navigate(actUrl); }}>
                        {#if actIcon}
                          {@html actIcon}
                        {:else}
                          <Icon kind="document-lines" />
                        {/if}
                      </button>
                      <div class="peek-popover">
                        <div class="peek-card" style:border-color="color-mix(in srgb, var(--{actColor}) 25%, var(--border))">
                          <div class="peek-card-header" style:border-bottom-color="color-mix(in srgb, var(--{actColor}) 25%, var(--border))">
                            {#if actIcon}
                              <span class="peek-card-icon" style:color="var(--{actColor})">{@html actIcon}</span>
                            {:else}
                              <Icon kind="document-lines" class="peek-card-icon" />
                            {/if}
                            <span class="peek-card-label">{act.summary}</span>
                          </div>
                          {#if typeof act.metadata?.iframeUrl === 'string' && act.metadata.iframeUrl}
                            <div class="peek-card-body peek-card-iframe">
                              <iframe
                                src={act.metadata.iframeUrl}
                                title={act.summary}
                                sandbox="allow-same-origin"
                                role="presentation"
                              ></iframe>
                            </div>
                          {:else if typeof act.metadata?.bodyHtml === 'string' && act.metadata.bodyHtml}
                            <div class="peek-card-body markdown-body">{@html renderMarkdown(act.metadata.bodyHtml)}</div>
                          {/if}
                        </div>
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
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
                  {@const startTime = new Date(turn.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  <div class="active-turn-wrapper">
                    <div class="active-turn-connector"></div>
                    <div class="active-turn-branch">
                      <div class="active-turn-header">
                        <span class="active-turn-time">{startTime} – now</span>
                      </div>
                      {#if events.length > 0}
                        {@const groups = groupToolEvents(events)}
                        {#each groups as groupItem (groupItem.kind === "tool-group" ? `tg-${groupItem.toolUse.id}` : `ev-${groupItem.event.id}`)}
                          {#if groupItem.kind === "tool-group"}
                            {@const catColor = getCategoryColor(groupItem.category)}
                            {@const catIcon = getCategoryIcon(groupItem.category)}
                            <div class="event" style:--type-color={catColor}>
                              <div class="marker marker-icon" style:color={catColor}>
                                <Icon kind={catIcon} />
                              </div>
                              <ToolGroupComponent group={groupItem} mindName={turn.mind} turnStatus="active" />
                            </div>
                          {:else}
                            <HistoryEvent event={groupItem.event} mindName={turn.mind} />
                          {/if}
                        {/each}
                      {/if}
                      <div class="active-indicator">
                        <div class="active-dot"></div>
                      </div>
                    </div>
                  </div>
                {/if}
              </div>
            </div>
          </div>
          {/if}
        {/each}
        {#if pendingInbounds.length > 0}
          <div class="turn-row">
            <div class="turn-time">
              just now
            </div>
            <div class="turn-rail turn-rail-expanded">
              <div class="turn-dot"></div>
            </div>
            <div class="turn-body">
              <div class="turn-summary">
                <div class="active-turn-wrapper">
                  <div class="active-turn-connector"></div>
                  <div class="active-turn-branch">
                    <div class="active-turn-header">
                      <span class="active-turn-time">{new Date(pendingInbounds[0].created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} – now</span>
                    </div>
                    {#each pendingInbounds as ev (ev.id)}
                      <HistoryEvent event={ev} mindName={ev.mind || name || ""} />
                    {/each}
                    <div class="active-indicator">
                      <div class="active-dot"></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        {/if}
        {#if name}
          {@const statusLabel = activeMinds.has(name) ? "active" : mindStatus === "sleeping" ? "asleep" : mindStatus === "running" ? "awake" : "offline"}
          {@const statusColor = activeMinds.has(name) ? undefined : mindStatus === "sleeping" ? "var(--purple)" : mindStatus === "running" ? "var(--text-0)" : "var(--text-2)"}
          <div class="turn-row turn-row-status">
            <div class="turn-time"></div>
            <div class="turn-rail turn-rail-terminus">
              <div class="mind-status-dot" class:iridescent={activeMinds.has(name)} style:background={statusColor}></div>
            </div>
            <div class="turn-body">
              <span class="mind-status-text" style:color={activeMinds.has(name) ? 'var(--accent)' : statusColor}>{name} is {statusLabel}</span>
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
    max-width: 720px;
    margin: 0 auto;
  }

  .turn-row {
    display: flex;
    align-items: flex-start;
    min-height: 48px;
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

  /* Extend HistoryEvent connectors to bridge the .turn-body padding gap.
     Use :global to reach into HistoryEvent's scoped styles.
     These only need to apply at the top level (turn-body > turn-summary),
     not inside nested summary-expand-branch or summary-nested-branch. */
  .turn-body > .turn-summary > :global(.event .turn-connector::after),
  .turn-body > .turn-summary > :global(.active-turn-wrapper .active-turn-connector::after) {
    left: -35px;
    width: 35px;
  }
  .turn-body > .turn-summary > :global(.event .branch-return) {
    left: -28px;
    width: 36px;
  }
  /* Inside summary-expand-branch, connectors bridge a shorter gap */
  .summary-expand-branch :global(.event .turn-connector::after),
  .summary-expand-branch :global(.active-turn-wrapper .active-turn-connector::after) {
    left: -23px;
    width: 23px;
  }
  .summary-expand-branch :global(.event .branch-return) {
    left: -16px;
    width: 24px;
  }
  /* Inside summary-nested-branch, same shorter gap */
  .summary-nested-branch :global(.event .turn-connector::after),
  .summary-nested-branch :global(.active-turn-wrapper .active-turn-connector::after) {
    left: -19px;
    width: 19px;
  }
  .summary-nested-branch :global(.event .branch-return) {
    left: -12px;
    width: 20px;
  }

  .turn-dot {
    position: absolute;
    top: 12px;
    right: -3px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-0);
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

  /* Peek icon buttons on the timeline rail */
  .turn-peek-icons {
    position: absolute;
    top: 40px; /* below the dot (dot is at top:12px, generous gap) */
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 30px;
    z-index: 4;
  }

  .peek-anchor {
    position: relative;
  }

  .peek-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--blue);
    cursor: pointer;
    padding: 0;
    transition: background 0.1s, border-color 0.1s;
  }

  .peek-btn :global(svg) {
    width: 10px;
    height: 10px;
  }

  .peek-btn:hover {
    background: var(--bg-2);
    border-color: var(--border-bright);
  }

  .peek-popover {
    display: none;
    position: absolute;
    top: -4px;
    left: calc(100% + 8px);
    z-index: 20;
    min-width: 280px;
    max-width: 400px;
    cursor: pointer;
    /* Invisible bridge from button to popover so hover persists */
    padding-left: 12px;
    margin-left: -12px;
  }

  .peek-anchor:hover .peek-popover {
    display: block;
  }

  .peek-card {
    background: var(--bg-0);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    cursor: pointer;
    transition: border-color 0.15s;
    color: var(--text-0);
    text-align: left;
    font: inherit;
  }

  .peek-card-chat {
    border-color: color-mix(in srgb, var(--blue) 25%, var(--border));
  }
  .peek-card-chat:hover {
    border-color: color-mix(in srgb, var(--blue) 50%, var(--border));
  }
  .peek-card-chat .peek-card-header {
    border-bottom-color: color-mix(in srgb, var(--blue) 25%, var(--border));
  }
  .peek-card-chat :global(.peek-card-icon) {
    color: var(--blue);
  }

  .peek-card-header {
    padding: 5px 10px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-1);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  :global(.peek-card-icon) {
    width: 13px;
    height: 13px;
    flex-shrink: 0;
  }

  .peek-card-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }

  .peek-card-meta {
    font-size: 11px;
    color: var(--text-2);
    font-weight: 400;
    flex-shrink: 0;
  }

  .peek-card-body {
    padding: 8px 10px;
    max-height: 300px;
    overflow-y: auto;
    color: var(--text-0);
  }

  .peek-msg {
    padding: 2px 0;
    font-family: var(--mono);
    font-size: 13px;
    color: var(--text-0);
    line-height: 1.5;
  }

  .peek-msg-sender {
    font-weight: 600;
    color: var(--accent);
    margin-right: 6px;
    font-size: 12px;
  }

  .peek-msg-sender-user {
    color: var(--blue);
  }

  .peek-msg-md :global(p) {
    margin: 0;
    display: inline;
  }

  .peek-card-iframe iframe {
    width: 100%;
    height: 200px;
    border: none;
    pointer-events: none;
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



  /* Active turn: branching inner rail matching expanded turns.
     Connector at left:22px matches HistoryEvent's .turn-connector position.
     Horizontal line at top:16px aligns with the turn-dot center (8px dot at top:12px). */
  .active-turn-wrapper {
    position: relative;
  }
  .active-turn-connector {
    position: absolute;
    top: 16px;
    left: 22px;
    width: 2px;
    bottom: 0;
    background: var(--border);
  }
  /* Horizontal connector from main rail to inner rail */
  .active-turn-connector::after {
    content: "";
    position: absolute;
    top: 0;
    left: -35px;
    width: 35px;
    height: 2px;
    background: var(--border);
  }
  /* Branch container: padding-left positions events so their markers land on the rail.
     Rail center = 22 + 1 = 23px from wrapper.
     Marker icons are 22px wide at left:-12px, center at (padLeft - 12 + 11).
     Solve: padLeft - 1 = 23 → padLeft = 24. */
  .active-turn-branch {
    position: relative;
    padding-left: 24px;
    padding-top: 8px;
    padding-bottom: 0;
  }

  .active-turn-branch .event {
    position: relative;
    padding: 6px 8px 6px 20px;
  }

  .active-turn-branch .marker {
    position: absolute;
    left: -5px;
    top: 12px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    z-index: 1;
  }

  .active-turn-branch .marker-icon {
    width: 22px;
    height: 22px;
    left: -12px;
    top: 5px;
    border-radius: var(--radius);
    background: var(--bg-1);
    border: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 3;
  }

  .active-turn-branch .marker-icon :global(svg) {
    width: 13px;
    height: 13px;
  }

  .active-turn-header {
    margin-bottom: 4px;
    margin-left: 14px;
  }
  .active-turn-time {
    font-size: 11px;
    color: var(--text-2);
  }

  .active-indicator {
    position: relative;
    height: 16px;
  }

  .active-dot {
    position: absolute;
    left: -5px;
    bottom: 0;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    z-index: 3;
    animation: iridescent 3s ease-in-out infinite;
  }

  .turn-rail-terminus {
    min-height: 8px;
  }
  .turn-rail-terminus::before {
    display: none;
  }

  .mind-status-dot {
    position: absolute;
    top: 0;
    right: -3px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    z-index: 3;
  }

  .mind-status-dot.iridescent {
    animation: iridescent 3s ease-in-out infinite;
  }

  .turn-row-status {
    min-height: 0 !important;
  }
  .turn-row:has(+ .turn-row-status) {
    min-height: 108px !important;
  }
  .turn-row:has(+ .turn-row-status) > .turn-rail::before {
    bottom: 0;
  }

  .mind-status-text {
    font-size: 15px;
    font-family: Georgia, "Times New Roman", serif;
    font-style: italic;
    line-height: 8px;
    padding-left: 20px;
  }

  @keyframes iridescent {
    0%   { background: #4ade80; }
    16%  { background: #60a5fa; }
    33%  { background: #c084fc; }
    50%  { background: #f472b6; }
    66%  { background: #fbbf24; }
    83%  { background: #34d399; }
    100% { background: #4ade80; }
  }

  /* Scale break: two diagonal lines on the rail with labels */
  .scale-break-row {
    min-height: 60px !important;
  }
  .scale-break-container {
    width: 2px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    position: relative;
    align-self: stretch;
  }
  /* Rail segments above and below the slashes, with a gap for the marks */
  .scale-break-container::before,
  .scale-break-container::after {
    content: "";
    position: absolute;
    width: 2px;
    background: var(--timeline-rail);
    left: 0;
  }
  .scale-break-container::before {
    top: 0;
    bottom: calc(50% + 8px);
  }
  .scale-break-container::after {
    bottom: 0;
    top: calc(50% + 8px);
  }
  .scale-break-slash {
    width: 14px;
    height: 2px;
    background: var(--timeline-rail);
    transform: rotate(-30deg);
  }
  .scale-break-gap {
    height: 14px;
  }
  .scale-break-label {
    position: absolute;
    left: 16px;
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 14px;
    color: var(--timeline-rail);
    white-space: nowrap;
  }
  .scale-break-label-above {
    top: 0;
  }
  .scale-break-label-below {
    bottom: 0;
  }
  .scale-break-arrow {
    width: 7px;
    height: 5px;
    flex-shrink: 0;
  }
  /* Nested expansion (hour→turn inside day→hour) */
  .summary-nested-wrapper {
    position: relative;
    margin-left: 8px;
  }
  .summary-nested-connector {
    position: absolute;
    top: 8px;
    left: 10px;
    width: 2px;
    bottom: 12px;
    background: var(--border);
  }
  .summary-nested-connector::after {
    content: "";
    position: absolute;
    top: 0;
    left: -19px;
    width: 19px;
    height: 2px;
    background: var(--border);
  }
  .summary-nested-branch {
    position: relative;
    padding-left: 12px;
    padding-top: 4px;
    padding-bottom: 8px;
  }
  .summary-nested-branch > :global(.event::after) {
    opacity: 1;
  }
  .summary-nested-return {
    position: absolute;
    bottom: 10px;
    left: -11px;
    width: 19px;
    height: 2px;
    background: var(--border);
  }

  /* Inner scale break inside expanded branches */
  .inner-scale-break {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 4px 0;
    margin-left: -2px;
    width: 14px;
  }

  /* Summary dot style */
  .summary-dot {
    border: 2px solid var(--text-2);
    background: var(--bg-1);
    box-sizing: border-box;
  }

  /* All summary text uses mono font */
  .summary-text {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--text-0);
    line-height: 1.5;
  }

  /* Collapsed summary with inline timestamp and clamped text */
  .summary-collapsed {
    cursor: pointer;
    padding: 6px 0;
  }
  .summary-collapsed-time {
    display: block;
    font-size: 11px;
    color: var(--text-2);
    margin-bottom: 2px;
  }
  .summary-collapsed .summary-text {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* Child summary items inside expanded branch */
  .summary-child-item {
    position: relative;
    padding: 8px 8px 8px 20px;
    cursor: pointer;
  }
  .summary-child-item:hover {
    background: color-mix(in srgb, var(--text-2) 5%, transparent);
    border-radius: var(--radius);
  }
  .summary-child-dot {
    position: absolute;
    left: -5px;
    top: 12px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    z-index: 1;
  }
  .summary-child-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .summary-child-time {
    font-size: 11px;
    color: var(--text-2);
  }
  /* Solid rail between child items */
  .summary-child-item::after {
    content: "";
    position: absolute;
    left: -2px;
    top: 20px;
    bottom: -6px;
    width: 2px;
    background: var(--border);
  }
  .summary-child-item:last-of-type::after {
    display: none;
  }

  /* Summary expansion: branch pattern matching HistoryEvent's turn expansion */
  .summary-expand-wrapper {
    position: relative;
  }
  .summary-expand-connector {
    position: absolute;
    top: 8px;
    left: 14px;
    width: 2px;
    bottom: 12px;
    background: var(--border);
  }
  .summary-expand-connector::after {
    content: "";
    position: absolute;
    top: 0;
    left: -26px;
    width: 26px;
    height: 2px;
    background: var(--border);
  }
  .summary-expand-branch {
    position: relative;
    padding-left: 16px;
    padding-top: 8px;
    padding-bottom: 8px;
  }
  /* Inner rail between children: ensure visibility */
  .summary-expand-branch > :global(.event::after) {
    opacity: 1;
  }
  .summary-expand-header {
    margin-bottom: 4px;
    margin-left: 6px;
    cursor: pointer;
  }
  .summary-expand-header:hover .active-turn-time {
    color: var(--text-0);
  }
  .summary-expand-loading {
    font-size: 12px;
    color: var(--text-2);
    font-style: italic;
    padding: 8px 0 8px 14px;
  }
  .summary-expand-collapse {
    position: relative;
    padding: 6px 8px 6px 20px;
    cursor: pointer;
    width: 100%;
    background: none;
    border: none;
    text-align: left;
    font: inherit;
    color: inherit;
  }
  .summary-expand-collapse::before {
    content: "";
    position: absolute;
    left: -5px;
    top: 12px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    border: 2px solid var(--text-2);
    background: var(--bg-1);
    box-sizing: border-box;
    z-index: 3;
  }
  .summary-expand-return {
    position: absolute;
    bottom: 10px;
    left: -19px;
    width: 27px;
    height: 2px;
    background: var(--border);
  }
  /* Highlight connectors on hover — only direct children, not nested branches */
  .summary-expand-wrapper:has(> .summary-expand-branch > .summary-expand-header:hover, > .summary-expand-branch > .summary-expand-collapse:hover) > .summary-expand-connector,
  .summary-expand-wrapper:has(> .summary-expand-branch > .summary-expand-header:hover, > .summary-expand-branch > .summary-expand-collapse:hover) > .summary-expand-connector::after,
  .summary-expand-wrapper:has(> .summary-expand-branch > .summary-expand-header:hover, > .summary-expand-branch > .summary-expand-collapse:hover) > .summary-expand-branch > .summary-expand-return {
    background: var(--text-0);
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
