<script lang="ts">
import type {
  ConversationWithParticipants,
  HistoryMessage,
  SummaryRow,
  TurnConversation,
  TurnRow,
} from "@volute/api";
import { Icon } from "@volute/ui";
import { SvelteMap, SvelteSet } from "svelte/reactivity";
import {
  fetchHistory,
  fetchSummaries,
  fetchSummaryByIds,
  fetchSystemInfo,
  fetchTurnEvents,
  fetchTurns,
} from "../lib/client";
import { formatRelativeTime, normalizeTimestamp } from "../lib/format";
import { navigate } from "../lib/navigate";
import { isUuid } from "../lib/peek";
import { parseISOWeek, summaryBounds, wallNow } from "../lib/period-keys";
import { activeMinds } from "../lib/stores.svelte";
import { mergeOlderSummaries, nextSummaryPage } from "../lib/summary-paging";
import {
  isRecentInbound,
  isTurnStale,
  pruneExpiredInbounds,
  reconnectDelay,
  turnLastSeenMs,
} from "../lib/timeline-liveness";
import { buildTodayItems } from "../lib/timeline-today";
import {
  appendStreamingGroups,
  groupToolEvents,
  type TimelineItem as ToolTimelineItem,
} from "../lib/tool-groups";
import { getCategoryColor, getCategoryIcon } from "../lib/tool-names";
import { summaryIconCount, turnRailParts } from "../lib/turn-rail";
import ToolGroupComponent from "./chat/ToolGroup.svelte";
import HistoryEvent from "./HistoryEvent.svelte";
import ReadOnlyChatModal from "./modals/ReadOnlyChatModal.svelte";
import RailIcons from "./RailIcons.svelte";
import SummaryNode from "./SummaryNode.svelte";
import TimelineBranch from "./TimelineBranch.svelte";

type TimelineItem =
  | { kind: "turn"; turn: TurnRow }
  | { kind: "summary"; summary: SummaryRow }
  | { kind: "separator"; above: string; below: string };

const CHILD_PERIOD: Record<string, "turn" | "hour" | "day" | "week" | "month"> = {
  hour: "turn",
  day: "hour",
  week: "day",
  month: "week",
};

// Period keys are server-local wall-clock time. Parse without Z suffix.
function periodKeyToDate(period: string, periodKey: string): Date {
  if (period === "hour")
    return new Date(`${periodKey.slice(0, 10)}T${periodKey.slice(11, 13)}:00:00`);
  if (period === "day") return new Date(`${periodKey}T00:00:00`);
  if (period === "week") return parseISOWeek(periodKey);
  if (period === "month") return new Date(`${periodKey}-01T00:00:00`);
  return new Date(periodKey);
}

// `serverTz` anchors Today/Yesterday and the current-year comparison to the
// daemon's timezone (period keys are server-local). Wall-clock labels
// themselves format the key's own numbers, so they're already zone-agnostic.
function formatPeriodTime(period: string, periodKey: string, serverTz?: string): string {
  const w = wallNow(serverTz);
  const todayLocal = new Date(w.year, w.month - 1, w.day);
  const yesterdayLocal = new Date(todayLocal);
  yesterdayLocal.setDate(todayLocal.getDate() - 1);

  if (period === "hour") {
    // Period keys are server-local wall time — parse and render directly
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
    if (start.getFullYear() !== w.year) {
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
// Replace-only arrays (all mutation sites reassign) → raw state avoids the cost
// of deep-proxying every row/summary on each update.
let turnsData = $state.raw<TurnRow[]>([]);
let loading = $state(false);
let historyError = $state("");

// Canonical timezone of the daemon host (period keys are computed in it).
// Fetched once at load; undefined falls back to browser-local time.
let serverTz = $state<string | undefined>(undefined);
// True once the timezone fetch has settled (resolved or failed). The initial
// summary load waits on this so cross-timezone viewers fetch server-anchored
// buckets on first paint instead of racing the fetch and using browser-local.
let serverTzResolved = $state(false);

let readOnlyConv = $state<ConversationWithParticipants | null>(null);

// --- Summaries data ---
let hourSummaries = $state.raw<SummaryRow[]>([]);
let daySummaries = $state.raw<SummaryRow[]>([]);
let weekSummaries = $state.raw<SummaryRow[]>([]);
let monthSummaries = $state.raw<SummaryRow[]>([]);
let summariesLoaded = $state(false);
// Backward summary paging (older history coarsens to week/month tiers).
let hasMoreSummaries = $state(true);
let loadingOlder = $state(false);
let canLoadOlder = $derived(
  hasMoreSummaries && (weekSummaries.length > 0 || monthSummaries.length > 0),
);
let expandedSummaries = $state(new SvelteMap<number, SummaryRow[] | TurnRow[]>());
let loadingChildren = new SvelteSet<number>();
// For single-turn hours: expand directly to raw events instead of showing the turn summary
let directEventsSummaries = $state(new SvelteMap<number, HistoryMessage[]>());

// A turn summary's period_key is the turn UUID. Legacy "<mind>-<doneId>" keys can't be
// resolved to turn events, so the direct-events drill-down must skip them (see #395).
const isTurnUuid = isUuid;

// --- Streaming events for active turns ---
// Raw events are the source of truth but non-reactive: rendering reads the
// pre-grouped `streamingGroups` instead, so a per-event append is O(1) DOM work
// and never re-derives `timelineItems`. `activeTurnIds` tracks streaming
// membership separately (only changes on turn start/complete) so appends — which
// leave membership untouched — don't invalidate the `timelineItems` derived.
const streamingEvents = new Map<string, HistoryMessage[]>();
const streamingGroups = new SvelteMap<string, ToolTimelineItem[]>();
const activeTurnIds = new SvelteSet<string>();

function setStreaming(turnId: string, events: HistoryMessage[]) {
  streamingEvents.set(turnId, events);
  streamingGroups.set(turnId, groupToolEvents(events));
  activeTurnIds.add(turnId);
}

function appendStreamingEvent(turnId: string, event: HistoryMessage) {
  const events = [...(streamingEvents.get(turnId) ?? []), event];
  streamingEvents.set(turnId, events);
  streamingGroups.set(
    turnId,
    appendStreamingGroups(streamingGroups.get(turnId) ?? [], events, event),
  );
}

function deleteStreaming(turnId: string) {
  streamingEvents.delete(turnId);
  streamingGroups.delete(turnId);
  activeTurnIds.delete(turnId);
}

let nextSyntheticId = -1;
// Inbound messages and system events that arrived before any turn_created — shown as provisional turn
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
    // Live mind-event envelopes still carry the routed thread as `session`.
    thread: (d.session as string) ?? null,
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
  let changed = false;
  const newRows: TurnRow[] = [];
  for (const row of rows) {
    const idx = turnsData.findIndex((t) => t.id === row.id);
    if (idx === -1) {
      newRows.push(row);
    } else {
      turnsData[idx] = row;
      changed = true;
    }
  }
  if (newRows.length > 0) {
    turnsData = [...turnsData, ...newRows];
  } else if (changed) {
    turnsData = [...turnsData];
  }
}

function openConversation(
  conv: Pick<TurnConversation, "id" | "label" | "type">,
  createdAt: string,
) {
  readOnlyConv = {
    id: conv.id,
    type: conv.type,
    user_id: null,
    created_at: createdAt,
    updated_at: createdAt,
    private: 0,
    channel_name: conv.type === "channel" ? conv.label.replace(/^#/, "") : null,
    participants: [],
  };
}

/** Wall-clock stamp for a turn row, mirroring the hour summaries' period labels. */
function formatTurnStamp(createdAt: string): string {
  return new Date(normalizeTimestamp(createdAt)).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
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
let reconnecting = $state(false);
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
// Last streaming-event time per active turn, for the staleness guard
const lastEventAt = new Map<string, number>();

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = reconnectDelay(reconnectAttempts);
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSSE();
  }, delay);
}

// Refetch page 1 after a reconnect and reconcile turns/streaming state so events
// missed while disconnected are recovered (turns completed, new turns, etc.).
async function resync() {
  if (!name) return;
  try {
    const rows = await fetchTurns({ mind: name, limit: PAGE_SIZE, offset: 0 });
    upsertTurnRows([...rows].reverse());
    for (const turn of turnsData) {
      if (turn.status === "active") {
        const turnId = turn.id;
        const turnMind = turn.mind;
        lastEventAt.set(turnId, Date.now());
        // Mark as streaming synchronously so a newly-discovered active turn renders live,
        // and so the completion guard below has a placeholder to observe.
        if (!streamingEvents.has(turnId)) setStreaming(turnId, []);
        fetchTurnEvents(turnMind, { turnId })
          .then((dbEvents) => {
            // A summary/done landing mid-fetch deletes streaming state; don't resurrect it.
            if (!streamingEvents.has(turnId)) return;
            setStreaming(turnId, dbEvents);
          })
          .catch((err) => console.warn("[TurnTimeline] Failed to resync active turn events:", err));
      } else if (streamingEvents.has(turn.id)) {
        // Turn completed while we were disconnected — drop the stale streaming view.
        deleteStreaming(turn.id);
        lastEventAt.delete(turn.id);
      }
    }
  } catch (err) {
    console.warn("[TurnTimeline] Failed to resync after reconnect:", err);
  }
}

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
    if ((eventType === "inbound" || eventType === "event") && !turnId) {
      // Show immediately as provisional turn before turn_created arrives. System events
      // ride the same path — HistoryEvent renders them as system markers, not as chat.
      pendingInbounds = [...pendingInbounds, buildHistoryMessage(d)];
    } else if (eventType === "turn_created" && turnId) {
      // Promote pending inbounds and system events into the real turn's streaming events
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
            events: [],
            activities: [],
          },
        ];
      }
      // Always merge pending inbounds into the turn (even if already initialized by backfill/duplicate)
      if (pendingInbounds.length > 0) {
        const seeded = pendingInbounds.map((ev) => ({ ...ev, turn_id: turnId }));
        const prev = streamingEvents.get(turnId) ?? [];
        setStreaming(turnId, [...seeded, ...prev]);
      } else if (!streamingEvents.has(turnId)) {
        setStreaming(turnId, []);
      }
      pendingInbounds = [];
      lastEventAt.set(turnId, Date.now());
      // Fetch turn events from DB after a short delay to allow retroactive inbound tagging.
      // DB events are authoritative — replace synthetic SSE events entirely.
      // Any SSE events arriving after this .then() runs are appended normally.
      const turnMind = (d.mind as string) ?? name ?? "";
      new Promise((r) => setTimeout(r, 500))
        .then(() => fetchTurnEvents(turnMind, { turnId }))
        .then((dbEvents) => {
          if (!streamingEvents.has(turnId)) return; // turn already completed
          setStreaming(turnId, dbEvents);
        })
        .catch((err) => console.warn("[TurnTimeline] Failed to fetch turn events:", err));
    } else if (eventType === "summary" && turnId) {
      // Turn complete — fetch the specific turn row and remove streaming state
      clearTimeout(doneFallbackTimers.get(turnId));
      doneFallbackTimers.delete(turnId);
      const prevStreaming = streamingEvents.get(turnId);
      deleteStreaming(turnId);
      lastEventAt.delete(turnId);
      fetchTurns({ mind: name, turnId })
        .then((rows) => {
          upsertTurnRows(rows);
          // The row's height changes as the branch collapses into a summary +
          // rail stack; if the user was pinned to the bottom, keep them there.
          requestAnimationFrame(() => {
            if (!userScrolledUp && scrollContainer) {
              scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: "smooth" });
            }
          });
        })
        .catch((err) => {
          console.warn("[TurnTimeline] Failed to fetch completed turn:", err);
          // Restore streaming state so the turn doesn't vanish
          if (!streamingEvents.has(turnId)) {
            setStreaming(turnId, prevStreaming ?? []);
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
              deleteStreaming(tid);
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
      // Substantive event — append to the streaming view incrementally (O(1)).
      appendStreamingEvent(turnId, buildHistoryMessage(d, { turn_id: turnId }));
      lastEventAt.set(turnId, Date.now());
    }

    scheduleScrollToBottom();
  };
  es.onopen = () => {
    clearReconnectTimer();
    const wasReconnecting = reconnecting;
    reconnectAttempts = 0;
    reconnecting = false;
    // Recover anything missed while the stream was down.
    if (wasReconnecting) resync();
  };
  es.onerror = () => {
    // EventSource auto-retries transient errors (CONNECTING). A permanent close
    // (CLOSED — e.g. a daemon restart returning an error) needs a manual reconnect
    // with backoff, or the timeline silently stops updating until a page reload.
    if (es.readyState === EventSource.CLOSED) {
      reconnecting = true;
      scheduleReconnect();
    } else if (es.readyState === EventSource.CONNECTING) {
      reconnecting = true;
    }
  };
  eventSource = es;
}

function disconnectSSE() {
  clearReconnectTimer();
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  for (const timer of doneFallbackTimers.values()) clearTimeout(timer);
  doneFallbackTimers.clear();
}

// --- Data loading ---
// Turns are only ever displayed for the current hour (older turns are reached
// through summaries), so a single page more than covers what's shown. There is
// no offset paging — walking back in time happens via loadOlderSummaries. All
// ingestion routes through upsertTurnRows, which dedups by id, so a re-fetch
// never produces duplicate keys in the keyed {#each} (which would crash it).
async function loadTurns() {
  loading = true;
  historyError = "";
  try {
    const rows = await fetchTurns({ mind: name, limit: PAGE_SIZE });
    const chronological = [...rows].reverse();
    upsertTurnRows(chronological);

    // Check for recent untagged inbound/event rows (arrived, but turn not yet started)
    if (pendingInbounds.length === 0 && name) {
      fetchHistory(name, { preset: "all", limit: 10 })
        .then((recent) => {
          // Only promote recent untagged inbounds — an old inbound a stopped/sleeping
          // mind never processed must not render as a perpetually-active turn.
          const untagged = recent.filter(
            (e) =>
              (e.type === "inbound" || e.type === "event") &&
              !e.turn_id &&
              isRecentInbound(e.created_at),
          );
          if (untagged.length > 0 && pendingInbounds.length === 0) {
            pendingInbounds = untagged;
          }
        })
        .catch((err) => console.warn("[TurnTimeline] Failed to check pending inbounds:", err));
    }

    // Backfill streaming events for any active turns
    for (const turn of turnsData) {
      if (turn.status === "active" && !streamingEvents.has(turn.id)) {
        setStreaming(turn.id, []);
        fetchTurnEvents(turn.mind, { turnId: turn.id })
          .then((dbEvents) => {
            if (!streamingEvents.has(turn.id)) return; // turn completed while fetching
            setStreaming(turn.id, dbEvents);
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
    // Boundaries are anchored to the server's timezone, since period keys are
    // computed there (see period-keys.ts). weekCutoff/currentMonthKey are the
    // date bounds for the tiers below "today"; the server translates the week
    // date bound to the matching ISO-week key.
    const bounds = summaryBounds(serverTz);

    // Fetch all summary periods in parallel
    const [hours, days, weeks, months] = await Promise.all([
      fetchSummaries({
        mind: name,
        period: "hour",
        from: bounds.todayHourFrom,
        to: bounds.hourCutoff,
        limit: 24,
        icons: true,
      }),
      fetchSummaries({
        mind: name,
        period: "day",
        from: bounds.weekCutoff,
        to: bounds.todayKey,
        limit: 7,
        icons: true,
      }),
      fetchSummaries({ mind: name, period: "week", to: bounds.weekCutoff, limit: 12, icons: true }),
      fetchSummaries({
        mind: name,
        period: "month",
        to: bounds.currentMonthKey,
        limit: 12,
        icons: true,
      }),
    ]);

    hourSummaries = hours.sort((a, b) => a.period_key.localeCompare(b.period_key));
    daySummaries = days
      .filter((d) => d.period_key < bounds.todayKey)
      .sort((a, b) => a.period_key.localeCompare(b.period_key));
    // Drop the current (partial) week so it doesn't show at both the week tier
    // and the day tier — days already cover the last 7 days. The server maps
    // weekCutoff (a date) to the week containing it, which may be the current
    // week, so this client-side guard is what keeps the seam clean.
    weekSummaries = weeks
      .filter((w) => w.period_key < bounds.currentWeekKey)
      .sort((a, b) => a.period_key.localeCompare(b.period_key));
    monthSummaries = months
      .filter((m) => m.period_key < bounds.currentMonthKey)
      .sort((a, b) => a.period_key.localeCompare(b.period_key));

    hasMoreSummaries = true;
    summariesLoaded = true;
  } catch (e) {
    console.warn("[TurnTimeline] Failed to load summaries:", e);
    summariesLoaded = true; // still mark loaded so we don't block the UI
  }
}

// Page backward through older summaries at the coarsest loaded tier.
async function loadOlderSummaries() {
  if (loadingOlder) return;
  const next = nextSummaryPage(weekSummaries, monthSummaries);
  if (!next) {
    hasMoreSummaries = false;
    return;
  }
  loadingOlder = true;
  try {
    const fetched = await fetchSummaries({
      mind: name,
      period: next.tier,
      to: next.to,
      limit: 12,
      icons: true,
    });
    if (next.tier === "month") {
      const { merged, exhausted } = mergeOlderSummaries(monthSummaries, fetched);
      monthSummaries = merged;
      if (exhausted) hasMoreSummaries = false;
    } else {
      const { merged, exhausted } = mergeOlderSummaries(weekSummaries, fetched);
      weekSummaries = merged;
      if (exhausted) hasMoreSummaries = false;
    }
  } catch (e) {
    console.warn("[TurnTimeline] Failed to load older summaries:", e);
  }
  loadingOlder = false;
}

async function toggleSummaryExpand(summary: SummaryRow) {
  if (expandedSummaries.has(summary.id) || directEventsSummaries.has(summary.id)) {
    expandedSummaries.delete(summary.id);
    directEventsSummaries.delete(summary.id);
    return;
  }

  loadingChildren.add(summary.id);

  try {
    const isSystem = summary.mind === "_system";
    const childPeriod = CHILD_PERIOD[summary.period];

    if (isSystem && childPeriod === "turn") {
      // System-level hourly summaries don't have source_ids to turns.
      // Instead, fetch per-mind summaries at the same period (hour).
      const minds: string[] =
        ((summary.metadata as Record<string, unknown>)?.minds as string[]) ?? [];
      const results = await Promise.all(
        minds.map((mind) =>
          fetchSummaries({
            mind,
            period: summary.period,
            from: summary.period_key,
            to: summary.period_key,
            limit: 1,
            icons: true,
          }),
        ),
      );
      const perMindSummaries = results.flat().sort((a, b) => a.mind.localeCompare(b.mind));
      expandedSummaries.set(summary.id, perMindSummaries);
    } else if (childPeriod === "turn") {
      // Per-mind hourly summaries have source_ids pointing to turn summaries.
      const sourceIds: number[] =
        ((summary.metadata as Record<string, unknown>)?.source_ids as number[]) ?? [];

      if (sourceIds.length > 0) {
        const turnSummaryRows = await fetchSummaryByIds(sourceIds);
        const uuidRows = turnSummaryRows.filter((s) => isTurnUuid(s.period_key));

        if (uuidRows.length < turnSummaryRows.length) {
          // One or more legacy keys can't be resolved to turns — render the summary rows
          // themselves rather than an empty drill-down.
          expandedSummaries.set(summary.id, turnSummaryRows);
        } else if (uuidRows.length === 1) {
          const events = await fetchTurnEvents(uuidRows[0].mind, {
            turnId: uuidRows[0].period_key,
          });
          directEventsSummaries.set(summary.id, events);
        } else if (uuidRows.length > 0) {
          const turns: TurnRow[] = await fetchTurns({
            turnIds: uuidRows.map((s) => s.period_key),
          });
          turns.sort((a, b) => a.created_at.localeCompare(b.created_at));
          expandedSummaries.set(summary.id, turns);
        } else {
          expandedSummaries.set(summary.id, []);
        }
      } else {
        expandedSummaries.set(summary.id, []);
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
        sunday.setDate(monday.getDate() + 6);
        const pad2 = (n: number) => String(n).padStart(2, "0");
        from = `${monday.getFullYear()}-${pad2(monday.getMonth() + 1)}-${pad2(monday.getDate())}`;
        to = `${sunday.getFullYear()}-${pad2(sunday.getMonth() + 1)}-${pad2(sunday.getDate())}`;
      } else if (summary.period === "month") {
        // Month "2026-03" → weeks/days within. Use the real last day so the
        // server's date→week-key mapping (for the week child tier) doesn't
        // overflow into the next month and pull in a non-overlapping week.
        const [my, mm] = summary.period_key.split("-").map(Number);
        const lastDay = new Date(my, mm, 0).getDate();
        from = `${summary.period_key}-01`;
        to = `${summary.period_key}-${String(lastDay).padStart(2, "0")}`;
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
        icons: true,
      });
      expandedSummaries.set(
        summary.id,
        children.sort((a, b) => a.period_key.localeCompare(b.period_key)),
      );
    }
  } catch (e) {
    console.warn("[TurnTimeline] Failed to load summary children:", e);
  }

  loadingChildren.delete(summary.id);
}

// Wall-clock anchor for the Today/this-hour boundaries. Held in state and
// refreshed on a coarse cadence (the liveness sweep + tab focus) so the derived
// isn't re-reading `new Date()` on unrelated invalidations and the "this hour"
// cutoff can't go stale while the view sits open.
let nowMs = $state(Date.now());

// Build the combined timeline items list
let timelineItems = $derived.by(() => {
  const items: TimelineItem[] = [];
  const now = new Date(nowMs);

  // Monthly summaries (oldest)
  for (const s of monthSummaries) items.push({ kind: "summary", summary: s });

  // Weekly summaries
  for (const s of weekSummaries) items.push({ kind: "summary", summary: s });

  // Separator if transitioning from week/month to day level
  if ((monthSummaries.length > 0 || weekSummaries.length > 0) && daySummaries.length > 0) {
    items.push({ kind: "separator", above: "earlier", below: "this week" });
  }

  // Daily summaries
  for (const s of daySummaries) items.push({ kind: "summary", summary: s });

  // Today section: hour summaries interleaved chronologically with individual turns.
  // Turns render individually when active/current-hour, or when they fall in an
  // earlier-today hour that has no hour summary yet — so a missing summary degrades
  // to more detail instead of a silent gap.
  const todayItems = buildTodayItems({
    now,
    hourSummaries,
    turnsData,
    isActive: (t) => t.status === "active" || activeTurnIds.has(t.id),
  });

  // Separator before the today section
  if (items.length > 0 && todayItems.length > 0) {
    items.push({ kind: "separator", above: "earlier this week", below: "today" });
  }

  for (const t of todayItems) items.push(t);

  return items;
});

// Trailing-edge auto-scroll: at most one instant jump per animation frame while
// events stream, instead of a smooth-animated scrollTo per event (which kept the
// view perpetually animating). Smooth scrolling is reserved for discrete actions
// (jump-to-latest, completed-turn reveal).
let scrollRafPending = false;
function scheduleScrollToBottom() {
  if (userScrolledUp || scrollRafPending) return;
  scrollRafPending = true;
  requestAnimationFrame(() => {
    scrollRafPending = false;
    if (!userScrolledUp && scrollContainer) {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }
  });
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
    streamingEvents.clear();
    streamingGroups.clear();
    activeTurnIds.clear();
    nextSyntheticId = -1;
    pendingInbounds = [];
    hourSummaries = [];
    daySummaries = [];
    weekSummaries = [];
    monthSummaries = [];
    summariesLoaded = false;
    hasMoreSummaries = true;
    expandedSummaries = new SvelteMap();
    directEventsSummaries = new SvelteMap();
    reconnecting = false;
    reconnectAttempts = 0;
    lastEventAt.clear();
    startScrollToBottom();
    loadTurns();
  }
});

// Liveness sweep: expire stale provisional inbounds and reconcile active turns that
// the server has likely finished (converges with the server's wedged-turn sweep).
$effect(() => {
  const onVisible = () => {
    if (document.visibilityState === "visible") nowMs = Date.now();
  };
  document.addEventListener("visibilitychange", onVisible);
  const interval = setInterval(() => {
    nowMs = Date.now();
    if (pendingInbounds.length > 0) {
      const pruned = pruneExpiredInbounds(pendingInbounds);
      if (pruned.length !== pendingInbounds.length) pendingInbounds = pruned;
    }
    const now = Date.now();
    for (const turn of turnsData) {
      if (turn.status !== "active") continue;
      const seen = turnLastSeenMs(turn.created_at, lastEventAt.get(turn.id));
      if (!isTurnStale(seen, now)) continue;
      lastEventAt.set(turn.id, now); // avoid refetch storms while awaiting the response
      fetchTurns({ mind: name, turnId: turn.id })
        .then((rows) => {
          const fresh = rows[0];
          if (fresh && fresh.status !== "active") {
            deleteStreaming(turn.id);
            lastEventAt.delete(turn.id);
          }
          upsertTurnRows(rows);
        })
        .catch((err) => console.warn("[TurnTimeline] Failed to check stale turn:", err));
    }
  }, 30_000);
  return () => {
    clearInterval(interval);
    document.removeEventListener("visibilitychange", onVisible);
  };
});

// Fetch the daemon's canonical timezone once, so boundary math and labels
// anchor to server-local time even when the browser is in another zone.
$effect(() => {
  fetchSystemInfo()
    .then((info) => {
      serverTz = info.timezone ?? undefined;
    })
    .catch(() => {})
    .finally(() => {
      serverTzResolved = true;
    });
});

// Load summaries once turns are available AND the timezone fetch has settled,
// so boundary math is anchored to the server zone on first paint.
$effect(() => {
  if (serverTzResolved && turnsData.length > 0 && !summariesLoaded && !loading) {
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
    {#if canLoadOlder}
      <div class="load-older">
        <button
          onclick={loadOlderSummaries}
          disabled={loadingOlder}
          class="load-older-btn"
          style:opacity={loadingOlder ? 0.5 : 1}
        >
          {loadingOlder ? "loading..." : "load older"}
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
            {@const icons = summary.icons}
            {@const iconCount = !isExpanded ? summaryIconCount(icons) : 0}
            <div class="turn-row" data-summary-id={summary.id} style:min-height={iconCount > 0 ? `${42 + iconCount * 30}px` : undefined}>
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
                {#if iconCount > 0 && icons}
                  <RailIcons groups={icons} mind={summary.mind} condensed onopenconversation={(c) => openConversation(c, summary.created_at)} />
                {/if}
              </div>
              <div class="turn-body">
                <div class="turn-summary">
                  <SummaryNode
                    {summary}
                    {expandedSummaries}
                    {directEventsSummaries}
                    {loadingChildren}
                    {toggleSummaryExpand}
                    formatPeriodTime={(p, k) => formatPeriodTime(p, k, serverTz)}
                    onopenconversation={openConversation}
                  />
                </div>
              </div>
            </div>
          {:else}
            {@const turn = item.turn}
          {@const showTurnStack = !expandedTurns.has(turn.id) && turn.status !== "active"}
          {@const peekCount = showTurnStack ? turnRailParts(turn).stackCount : 0}
          <div class="turn-row" data-turn-id={turn.id} style:min-height={peekCount > 0 ? `${36 + peekCount * 48}px` : undefined}>
            <div class="turn-time">
              {#if !name}
                <button class="mind-badge" onclick={() => navigate(`/minds/${turn.mind}/history`)}>{turn.mind}</button>
              {/if}
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
              {#if !turn.trigger}
                <div class="turn-dot"></div>
              {/if}
              <!-- Trigger chip at the dot + per-item stack below (RailIcons) -->
              <RailIcons {turn} mind={turn.mind} showStack={showTurnStack} onopenconversation={(c) => openConversation(c, turn.created_at)} />
            </div>
            <div class="turn-body">
              <div class="turn-summary">
                {#if turn.summary || turn.status === "complete"}
                  <!-- Wall-clock stamp beside the trigger dot, mirroring summary period labels -->
                  <div class="turn-stamp">{formatTurnStamp(turn.created_at)}</div>
                {/if}
                {#if turn.summary}
                  <HistoryEvent
                    event={{
                      id: 0,
                      mind: turn.mind,
                      channel: "",
                      thread: null,
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
                    onexpand={(expanded) => handleExpand(turn.id, expanded)}
                  />
                {:else if turn.status === "complete"}
                  <!-- Complete but no summary (e.g. daemon restarted mid-turn). An event-triggered
                       turn must not be rebuilt with the event's channel/sender: that is exactly the
                       message-shaped row this change exists to eliminate. `trigger.event` is the
                       authoritative signal from the API — use it, don't sniff the channel. -->
                  <HistoryEvent
                    event={{
                      id: 0,
                      mind: turn.mind,
                      channel: turn.trigger?.event ? "" : (turn.trigger?.channel ?? ""),
                      thread: null,
                      sender: turn.trigger?.event ? null : (turn.trigger?.sender ?? null),
                      message_id: null,
                      type: "summary",
                      content: turn.trigger?.event
                        ? `System event: ${turn.trigger.event.label}`
                        : (turn.trigger?.content ?? "(no summary)"),
                      metadata: null,
                      turn_id: turn.id,
                      created_at: turn.created_at,
                    }}
                    mindName={turn.mind}
                    expandable
                    onexpand={(expanded) => handleExpand(turn.id, expanded)}
                  />
                {:else}
                  {@const groups = streamingGroups.get(turn.id) ?? []}
                  {@const startTime = new Date(turn.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  <TimelineBranch gap={24} reach={11} noReturn>
                    {#snippet header()}
                      <div class="active-turn-header">
                        <span class="active-turn-time">{startTime} – now</span>
                      </div>
                    {/snippet}
                    {#snippet children()}
                      {#if groups.length > 0}
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
                    {/snippet}
                  </TimelineBranch>
                {/if}
              </div>
            </div>
          </div>
          {/if}
        {/each}
        {#if pendingInbounds.length > 0}
          <div class="turn-row">
            <div class="turn-time">
              {formatRelativeTime(pendingInbounds[0].created_at)}
            </div>
            <div class="turn-rail turn-rail-expanded">
              <div class="turn-dot-icon" style:color={pendingInbounds[0].type === "event" ? "var(--purple)" : "var(--blue)"}>
                <Icon kind={pendingInbounds[0].type === "event" ? "gear" : "chat"} />
              </div>
            </div>
            <div class="turn-body">
              <div class="turn-summary">
                <TimelineBranch gap={24} reach={11} noReturn>
                  {#snippet header()}
                    <div class="active-turn-header">
                      <span class="active-turn-time">{new Date(pendingInbounds[0].created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} – now</span>
                    </div>
                  {/snippet}
                  {#snippet children()}
                    {#each pendingInbounds as ev (ev.id)}
                      <HistoryEvent event={ev} mindName={ev.mind || name || ""} />
                    {/each}
                    <div class="active-indicator">
                      <div class="active-dot"></div>
                    </div>
                  {/snippet}
                </TimelineBranch>
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
              {#if reconnecting}
                <span class="reconnecting-text">reconnecting…</span>
              {/if}
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
    mindName={name ?? ""}
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
    /* Asymmetric: room for the time column on the left, scrollbar hugs the pane edge on the right */
    padding: 0 8px 0 16px;
  }

  .turn-track {
    position: relative;
    min-height: 100%;
    max-width: 720px;
    margin: 0 auto;
    padding-bottom: 16px;
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

  /* Extend HistoryEvent connectors to bridge the .turn-body padding gap (12px).
     HistoryEvent's default connector is left:-23px, width:23px.
     At top level, the gap is wider (12px body padding + 14px branch padding = 26px from inner rail to main rail).
     At nested levels, the gap is narrower. */
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
    right: -3px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-0);
    z-index: 3;
  }


  /* Wall-clock stamp above the turn summary, mirroring .summary-collapsed-time */
  .turn-stamp {
    padding: 8px 0 0 20px;
    font-size: 11px;
    color: var(--text-2);
    line-height: 1;
  }

  /* Trigger-icon chip on the provisional pending-turn row; center matches the
     dot's (y=16px). pointer-events pass through to the rail. */
  .turn-dot-icon {
    position: absolute;
    top: 7px;
    left: 50%;
    transform: translateX(-50%);
    width: 18px;
    height: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    z-index: 3;
    pointer-events: none;
  }

  .turn-dot-icon :global(svg) {
    width: 10px;
    height: 10px;
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



  /* Inline event styling for active-turn tool groups */
  .event {
    position: relative;
    padding: 6px 8px 6px 20px;
  }
  .marker {
    position: absolute;
    left: -5px;
    top: 12px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    z-index: 1;
  }
  .marker-icon {
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
  .marker-icon :global(svg) {
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

  .reconnecting-text {
    display: inline-block;
    margin-top: 6px;
    padding-left: 20px;
    font-size: 12px;
    color: var(--text-2);
    animation: pulse 1.5s infinite;
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
  /* Summary dot style */
  .summary-dot {
    border: 2px solid var(--text-2);
    background: var(--bg-1);
    box-sizing: border-box;
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
