import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { captureReflection, clearDeliveredEvents, recordNotice } from "../chat/system-events.js";
import { getTypingMap, publishTypingForChannels } from "../chat/typing.js";
import { getDb } from "../db.js";
import { getDeliveryManager } from "../delivery/delivery-manager.js";
import { echoTextToChannel } from "../delivery/echo-text.js";
import { linkToolResultToTurn } from "../delivery/message-delivery.js";
import { broadcast } from "../events/activity-events.js";
import { onMindEvent } from "../events/mind-activity-tracker.js";
import { publish as publishMindEvent } from "../events/mind-events.js";
import { mindHistory, turns } from "../schema.js";
import log from "../util/logger.js";
import { classify } from "./error-classify.js";
import { summarizeTurn } from "./summarizer.js";
import { getTokenBudget } from "./token-budget.js";
import {
  assignSession,
  completeTurn,
  createTurn,
  getActiveTurnId,
  getToolUseEventId,
  markErrored,
  takeErrored,
  trackToolUse,
} from "./turn-tracker.js";

const llog = log.child("turn-lifecycle");

/** Event types that trigger turn creation (hoisted for perf — avoid per-request allocation). */
const SUBSTANTIVE_TYPES = new Set(["thinking", "text", "tool_use", "tool_result", "outbound"]);

/** Strip correlation markers from tool_result content before persisting/publishing. */
const MARKER_RE = /\[volute:(?:outbound|activity):\d+\]/g;

/**
 * A single event streamed from a mind's server to the daemon. Mirrors the JSON body
 * accepted by `POST /:name/events`; the HTTP route is a thin adapter over
 * {@link handleMindEvent}.
 */
export type MindEvent = {
  type: string;
  session?: string;
  channel?: string;
  messageId?: string;
  content?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Highest notice id drained by the pre-prompt hook per `mind:session`. A clean turn
 * only marks notices delivered up to this id, so a notice created mid-turn isn't lost
 * before the mind reads it.
 */
const noticeDrainWatermarks = new Map<string, number>();

/** Record the high-water notice id drained for a `mind:session` (set by the pre-prompt hook). */
export function setNoticeDrainWatermark(mind: string, session: string, id: number): void {
  noticeDrainWatermarks.set(`${mind}:${session}`, id);
}

/**
 * On a turn that completed without an error event, mark the notices the mind actually
 * drained this turn as delivered. If the turn errored, leave them queued so they reach
 * the mind on its next genuinely successful turn. `takeErrored` both reads and clears
 * the flag, so call it exactly once per completed turn.
 */
function markDeliveredOnCleanTurn(mind: string, session?: string | null): void {
  if (!session) return;
  const wmKey = `${mind}:${session}`;
  const watermark = noticeDrainWatermarks.get(wmKey);
  noticeDrainWatermarks.delete(wmKey);
  const errored = takeErrored(mind, session);
  if (!errored && watermark != null) {
    clearDeliveredEvents(mind, session, watermark).catch((err) =>
      llog.warn(`failed to clear delivered notices for ${mind}:${session}`, log.errorData(err)),
    );
  }
}

/**
 * Link the inbound message(s) that triggered a turn to that turn, and set the turn's
 * `trigger_event_id`. Runs once, at turn creation.
 *
 * Two failure modes this guards against (see #403):
 *
 * 1. **Channel race.** The turn-creating event (`thinking`/`text`/…) only carries a channel
 *    once the template's message→channel mapping is established — a timing race. When it's
 *    absent we fall back to the turn's `session`, which is channel-shaped for the default
 *    routes (`session = ${channel}`, so a DM session *is* the `@handle` slug). A session that
 *    isn't a channel slug (e.g. the `main` default) simply matches no inbound rows — a safe
 *    no-op rather than a mis-tag.
 * 2. **Unbounded sweep.** We only claim untagged inbounds that arrived at/after the previous
 *    turn on this session was created. Without that bound a late turn hoovers stale inbounds
 *    that belonged to (or were abandoned by) an earlier turn. Inbounds older than the bound
 *    stay untagged — they genuinely never got their own turn.
 */
async function linkPendingInbound(
  mind: string,
  turnId: string,
  channel: string | undefined,
  session: string | undefined,
): Promise<void> {
  const scopeChannel = channel ?? session;
  if (!scopeChannel) return;
  const db = await getDb();

  // Lower-bound the sweep by the previous turn on this session (assignSession has already
  // written this turn's `session`, so `id != turnId` excludes it from the max).
  let lowerBound: string | undefined;
  if (session) {
    const prev = await db
      .select({ max: sql<string | null>`max(${turns.created_at})` })
      .from(turns)
      .where(and(eq(turns.mind, mind), eq(turns.thread, session), sql`${turns.id} != ${turnId}`))
      .get();
    lowerBound = prev?.max ?? undefined;
  }

  const conditions = [
    eq(mindHistory.mind, mind),
    // "event" rows are system events (see recordEventRow) — not messages, but they
    // trigger turns the same way, and this linkage is what sets `trigger_event_id` and
    // thus drives reflection capture. Dropping them here breaks it silently.
    inArray(mindHistory.type, ["inbound", "event"]),
    sql`${mindHistory.turn_id} IS NULL`,
    eq(mindHistory.channel, scopeChannel),
  ];
  if (lowerBound) conditions.push(gte(mindHistory.created_at, lowerBound));

  const pending = await db
    .select({ id: mindHistory.id })
    .from(mindHistory)
    .where(and(...conditions))
    .orderBy(mindHistory.id);
  if (pending.length === 0) return;
  const ids = pending.map((r) => r.id);
  await db.update(mindHistory).set({ turn_id: turnId }).where(inArray(mindHistory.id, ids));
  // Trigger is the earliest inbound in the window — the message that started the turn.
  await db.update(turns).set({ trigger_event_id: ids[0] }).where(eq(turns.id, turnId));
}

/**
 * Drive the delivery/turn state machine for a single mind event.
 *
 * Owns the full lifecycle previously inlined in the `POST /:name/events` handler:
 * turn create/assign/complete, trigger linking, marker fallback linking, typing clears,
 * failure/budget notices, the summarization trigger, and budget accounting. Extracted
 * here so the state machine is unit-testable without a live HTTP server.
 *
 * Returns the resolved `turnId` (if any) and the persisted mind_history `insertedId`.
 */
export async function handleMindEvent(
  mind: string,
  event: MindEvent,
): Promise<{ turnId?: string; insertedId?: number }> {
  // Assign session to a sessionless turn on first session_start.
  if (event.type === "session_start" && event.session) {
    const activeTurnId = getActiveTurnId(mind);
    if (activeTurnId) await assignSession(mind, activeTurnId, event.session);
  }

  // Look up active turn for this event; create one if missing for substantive events.
  // Turns are created per-session when the mind starts processing, not when inbound arrives.
  let turnId = getActiveTurnId(mind, event.session);
  if (!turnId && SUBSTANTIVE_TYPES.has(event.type)) {
    turnId = await createTurn(mind);
    if (!turnId) {
      llog.warn(`skipping turn tracking for ${mind}: createTurn failed`);
    } else {
      publishMindEvent(mind, { mind, type: "turn_created", turnId });
      if (event.session) await assignSession(mind, turnId, event.session);
      // Link the triggering inbound(s) and set the turn's trigger_event_id.
      try {
        await linkPendingInbound(mind, turnId, event.channel, event.session);
      } catch (err) {
        llog.warn(
          `failed to link trigger inbound for turn ${turnId} (mind: ${mind})`,
          log.errorData(err),
        );
      }
    }
  }

  const cleanContent =
    event.type === "tool_result" && event.content
      ? event.content.replace(MARKER_RE, "").trimEnd()
      : event.content;

  // Persist to mind_history.
  const db = await getDb();
  let insertedId: number | undefined;
  try {
    const result = await db
      .insert(mindHistory)
      .values({
        mind,
        type: event.type,
        thread: event.session ?? null,
        channel: event.channel ?? null,
        message_id: event.messageId ?? null,
        content: cleanContent ?? null,
        metadata: event.metadata ? JSON.stringify(event.metadata) : null,
        turn_id: turnId ?? null,
      })
      .returning({ id: mindHistory.id });
    insertedId = result[0]?.id;
  } catch (err) {
    // A dropped event is a permanent gap in this mind's history/timeline — surface it
    // with enough context to spot which mind/session/channel lost what, rather than
    // failing silently. Persistence stays best-effort so real-time streaming continues.
    llog.error(
      `HISTORY GAP: failed to persist ${event.type} event for ${mind}` +
        `${event.session ? ` (session ${event.session})` : ""}` +
        `${event.channel ? ` on ${event.channel}` : ""}`,
      log.errorData(err),
    );
  }

  // Track tool_use events for source_event_id linking, indexed by the SDK tool_use id
  // (in metadata.id) so a parallel tool_result resolves to its own tool_use.
  if (event.type === "tool_use" && insertedId != null) {
    const toolUseId = typeof event.metadata?.id === "string" ? event.metadata.id : undefined;
    trackToolUse(mind, event.session, insertedId, toolUseId);
  }

  // Fallback/activity linking via correlation markers. Outbound turn attribution is now
  // primary via the session header at send time (see api/chat.ts); linkToolResultToTurn
  // is idempotent (won't re-publish an already-attributed outbound) and still links
  // extension activities and any outbound the direct path couldn't attribute.
  if (event.type === "tool_result" && turnId && event.content) {
    const resultToolUseId =
      typeof event.metadata?.tool_use_id === "string" ? event.metadata.tool_use_id : undefined;
    const toolUseEventId = getToolUseEventId(mind, event.session, resultToolUseId);
    try {
      await linkToolResultToTurn(mind, turnId, event.content, toolUseEventId);
    } catch (err) {
      llog.error("failed to link tool_result to turn", log.errorData(err));
    }
  }

  // Publish to in-process pub-sub.
  publishMindEvent(mind, {
    mind,
    type: event.type,
    session: event.session,
    channel: event.channel,
    messageId: event.messageId,
    content: cleanContent,
    metadata: event.metadata,
    turnId: turnId ?? undefined,
  });

  if (event.type === "text" && event.channel && cleanContent) {
    echoTextToChannel(mind, event.channel, cleanContent, turnId ?? undefined, insertedId).catch(
      (err) => llog.error(`echo-text failed for ${mind} on ${event.channel}`, log.errorData(err)),
    );
  }

  // Track mind activity for the dashboard timeline.
  onMindEvent(mind, event.type, event.channel);

  // Turn failure: record a notice and flag the session as errored so the upcoming `done`
  // does NOT mark notices delivered (failures accumulate until a clean turn).
  if (event.type === "error" && event.session) {
    markErrored(mind, event.session);
    const { reason, detail } = classify(event.content ?? "");
    await recordNotice({
      mind,
      thread: event.session,
      kind: "turn_error",
      reason,
      detail,
      raw: event.content ?? null,
    });
    // Nudge connected web clients to refresh mind status so chat surfaces the
    // failure immediately (#574).
    broadcast({ type: "mind_error", mind, summary: detail });
  }

  if (event.type === "done") {
    // Turn end: clear the persistent typing entries set at delivery (delivery-manager)
    // and push the update to web clients. This is the canonical mid-flight clear — do
    // not clear earlier (e.g. on text/outbound); typing means "on a turn", not "about
    // to send here".
    const map = getTypingMap();
    publishTypingForChannels(map.deleteSender(mind), map);
    broadcast({ type: "mind_done", mind, summary: "Finished processing" });
    // Notify delivery manager of session completion (synchronous — decrement must happen
    // atomically before the busy check to avoid interleaving with a concurrent delivery).
    try {
      getDeliveryManager().sessionDone(mind, event.session);
    } catch (err) {
      if (!(err instanceof Error && err.message.includes("not initialized"))) {
        llog.error(`delivery manager sessionDone failed for ${mind}`, log.errorData(err));
      }
    }
    await completeTurnAndSummarize(mind, event, insertedId);
  }

  // Record usage against budget.
  if (event.type === "usage" && event.metadata) {
    const inputTokens = (event.metadata.input_tokens as number) ?? 0;
    const outputTokens = (event.metadata.output_tokens as number) ?? 0;
    const tb = getTokenBudget();
    tb.recordUsage(mind, inputTokens, outputTokens);
    if (event.session && tb.noteExceeded(mind)) {
      void recordNotice({
        mind,
        thread: event.session,
        kind: "budget",
        reason: "token_budget",
        detail:
          "You've used your token budget for this period, so your activity may pause until it resets. This isn't anything you did wrong — it's just a rest imposed by the budget. Anything that arrives while you're paused will be kept for you. If you're mid-thought, this turn is a good moment to jot it down.",
      });
    }
  }

  return { turnId: turnId ?? undefined, insertedId };
}

/**
 * Complete the turn on a `done` event if the session has no more pending deliveries,
 * then mark drained notices delivered and fire summarization.
 */
async function completeTurnAndSummarize(
  mind: string,
  event: MindEvent,
  insertedId: number | undefined,
): Promise<void> {
  const finish = async () => {
    const completedTurnId = await completeTurn(mind, event.session);
    markDeliveredOnCleanTurn(mind, event.session);
    // If this turn was triggered by an immediate system event (exact match via the
    // turn's trigger_event_id), record its final text as the event's reflection
    // (logged only — delivered nowhere).
    captureReflection(mind, completedTurnId).catch((err) =>
      llog.warn("failed to capture event reflection", log.errorData(err)),
    );
    if (insertedId != null) {
      summarizeTurn(mind, event.session, event.channel, insertedId, completedTurnId).catch((err) =>
        llog.error("turn summarization failed", log.errorData(err)),
      );
    }
  };

  try {
    // Only gate on delivery busy state when we have a session. Sessionless done events
    // (background/system work) complete immediately to avoid being blocked by unrelated
    // active sessions. When messages arrive mid-turn their incrementActive() keeps the
    // count > 0, so we skip here; the subsequent done will re-check.
    const dm = getDeliveryManager();
    const busy = event.session ? dm.isSessionBusy(mind, event.session) : false;
    if (!busy) await finish();
  } catch (err) {
    if (!(err instanceof Error && err.message.includes("not initialized"))) {
      llog.error("turn completion check failed", log.errorData(err));
    }
    // DM unavailable — complete immediately as fallback.
    await finish();
  }
}
