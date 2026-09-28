import { and, eq, gte, inArray, sql } from "drizzle-orm";
import {
  captureReflection,
  clearDeliveredEvents,
  deliverEvent,
  MIND_LEVEL_THREAD,
  recordNotice,
} from "../chat/system-events.js";
import { getTypingMap, publishTypingForChannels } from "../chat/typing.js";
import { getDb } from "../db.js";
import { getDeliveryManager } from "../delivery/delivery-manager.js";
import { echoTextToChannel } from "../delivery/echo-text.js";
import { linkToolResultToTurn } from "../delivery/message-delivery.js";
import { broadcast } from "../events/activity-events.js";
import { onMindEvent } from "../events/mind-activity-tracker.js";
import { publish as publishMindEvent } from "../events/mind-events.js";
import { getPrompt } from "../prompts.js";
import { mindHistory, turns } from "../schema.js";
import log from "../util/logger.js";
import { classify } from "./error-classify.js";
import { ManagerNotReadyError } from "./manager-not-ready.js";
import { type BudgetScope, getSpendBudget } from "./spend-budget.js";
import { summarizeTurn } from "./summarizer.js";
import {
  completeTurn,
  createTurn,
  getActiveTurnId,
  getActiveTurnOwner,
  getToolUseEventId,
  markErrored,
  normalizeThread,
  setDrainWatermark,
  takeDrainWatermark,
  takeErrored,
  trackToolUse,
} from "./turn-tracker.js";
import { mindPricingContext, priceUsageMetadata } from "./usage-pricing.js";

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
  /**
   * On a `done`: the deliveries it finished — the one that drove the turn plus any the mind
   * folded into it (#1207). Absent from a template that predates it.
   */
  covers?: string[];
  /**
   * On a `done`: false when it ends no turn — it only retires a delivery that failed while
   * another turn ran on (pi's rejected followUp). Every other `done` ends a turn.
   */
  endsTurn?: boolean;
};

/**
 * The delivery a mind's event names, if it is one the daemon delivered to that session and
 * no `done` has covered yet — the only ids a turn's error flag or drain watermark is keyed
 * by. Anything else a mind sends is read as naming no turn, so a mind can't grow the
 * daemon's per-delivery state with ids of its own.
 */
function outstandingId(mind: string, session: string, messageId: string | undefined) {
  if (messageId === undefined) return undefined;
  try {
    return getDeliveryManager().isOutstanding(mind, session, messageId) ? messageId : undefined;
  } catch {
    return undefined;
  }
}

/** Record the high-water notice id drained for a turn (set by the pre-prompt hook). */
export function setNoticeDrainWatermark(
  mind: string,
  session: string,
  id: number,
  messageId?: string,
): void {
  setDrainWatermark(mind, session, id, outstandingId(mind, session, messageId));
}

/** What a `done` does to its session, decided the moment it arrives (see `readDone`). */
type DoneState = {
  /** The `done` ends a turn — the mind's, or a variant's beside it. */
  ends: boolean;
  /** It closes the session's active turn — or there is none to close. */
  closes: boolean;
  /** The active turn it closes, as it stood when the `done` arrived. */
  turnId: string | undefined;
  /** No turn runs on once it is handled, so the session's slot may go back. */
  releases: boolean;
  /** The outstanding deliveries it finishes (see `DeliveryManager.coveredBy`). */
  retired: string[] | undefined;
  /** Highest notice id the ended turn drained. */
  watermark: number | undefined;
  errored: boolean;
};

/**
 * Take what a `done` closes over, synchronously on its arrival.
 *
 * A `done` names the turn it ends (`messageId`) and the deliveries it finished (`covers`).
 * One without `covers` comes from a template that predates the field: it ends the turn and
 * covers everything its process had outstanding. One with `endsTurn: false` ends no turn —
 * it retires a delivery that failed while another turn ran on (pi's rejected followUp).
 *
 * A `done` closes the session's active turn only if it comes from the process that opened
 * it: a variant shares its parent's turn key, and its `done` must not cut the parent's
 * turn short. A `done` that ends a turn takes the drain watermarks and error flags of the
 * deliveries it finished — and, if it closes the session's turn, those that named none —
 * before anything awaits, so a drain for the next turn is never claimed by this one's. A
 * `done` that ends no turn drops its failed deliveries' flags, whose turns never ran.
 */
function readDone(mind: string, event: MindEvent, process: string): DoneState {
  const session = event.session;
  const legacy = event.covers === undefined;
  const ends = event.endsTurn !== false;
  const turnId = getActiveTurnId(mind, session);
  const closes = ends && (turnId === undefined || getActiveTurnOwner(mind, session) === process);
  // A `done` that ends no turn still frees the slot when no turn runs: the one it failed
  // beside has already ended, and its own `done` could not free what this delivery held.
  const releases = ends || turnId === undefined;
  let retired: string[] | undefined;
  try {
    retired = getDeliveryManager().coveredBy(mind, session, {
      process,
      messageId: event.messageId,
      covers: event.covers,
      endsTurn: ends,
    });
  } catch (err) {
    if (!(err instanceof ManagerNotReadyError)) {
      llog.error(`delivery manager coveredBy failed for ${mind}`, log.errorData(err));
    }
  }
  const state = { ends, closes, turnId, releases, retired };
  if (!session) return { ...state, watermark: undefined, errored: false };

  const named = [...new Set([...(event.covers ?? []), ...(retired ?? [])])];
  if (event.messageId !== undefined) named.push(event.messageId);
  if (!ends) {
    takeDrainWatermark(mind, session, named, false);
    takeErrored(mind, session, named, false);
    return { ...state, watermark: undefined, errored: false };
  }
  // A turn that closes the session's reads the whole session for a template that predates
  // `covers`, as it always did; one beside another process's turn reads only its own.
  const ids = closes && legacy ? undefined : named;
  return {
    ...state,
    watermark: takeDrainWatermark(mind, session, ids, closes),
    errored: takeErrored(mind, session, ids, closes),
  };
}

/**
 * On a turn that completed without an error event, mark the notices the mind actually
 * drained this turn as delivered. If the turn errored, leave them queued so they reach
 * the mind on its next genuinely successful turn.
 */
function markDeliveredOnCleanTurn(mind: string, session: string, done: DoneState): void {
  if (!done.errored && done.watermark != null) {
    clearDeliveredEvents(mind, session, done.watermark).catch((err) =>
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

  // Lower-bound the sweep by the previous turn on this session (createTurn has already
  // written this turn's thread, so `id != turnId` excludes it from the max).
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
 * `mind` is the base name history is kept under; `process` is the mind or variant whose
 * server sent the event (it owns a turn it opens — see `ActiveTurn.owner`).
 *
 * Returns the resolved `turnId` (if any) and the persisted mind_history `insertedId`.
 */
export async function handleMindEvent(
  mind: string,
  event: MindEvent,
  process: string = mind,
): Promise<{ turnId?: string; insertedId?: number }> {
  // Look up active turn for this event; create one if missing for substantive events.
  // Turns are created per-session when the mind starts processing, not when inbound arrives,
  // and keyed by the event's own thread from the start — never borrowed from a sibling.
  let turnId = getActiveTurnId(mind, event.session);
  // Synchronous with the `done`'s arrival — see readDone.
  const done = event.type === "done" ? readDone(mind, event, process) : undefined;
  // A `done` that doesn't close the running turn isn't that turn's end, and must not be
  // recorded as one — the wedged-turn sweep reads a turn's `done` rows as its having ended.
  if (done && !done.closes) turnId = undefined;
  if (!turnId && SUBSTANTIVE_TYPES.has(event.type)) {
    turnId = await createTurn(mind, event.session, process);
    if (!turnId) {
      llog.warn(`skipping turn tracking for ${mind}: createTurn failed`);
    } else {
      publishMindEvent(mind, { mind, type: "turn_created", turnId });
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

  // Price usage before persisting, so the row carries the cost the turn actually incurred
  // at the rates in force when it ran. Enriching after the insert would leave history
  // dependent on a catalog that changes underneath it.
  if (event.type === "usage" && event.metadata) {
    try {
      Object.assign(
        event.metadata,
        priceUsageMetadata(event.metadata, await mindPricingContext(mind)),
      );
    } catch (err) {
      llog.error(`failed to price usage event for ${mind}`, log.errorData(err));
    }
  }

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

  // Fallback linking via correlation markers. Sends and command activities are attributed
  // at send/publish time from the caller's thread (api/chat.ts, publishTurnActivity);
  // linkToolResultToTurn fills in what that couldn't: a send from this thread made before
  // its turn existed (re-published once, with the turn), or an unstamped activity of this
  // mind. It never overwrites a turn or crosses threads — or processes: a variant's thread
  // shares its parent's turn key, so only the process that opened the turn links into it.
  if (
    event.type === "tool_result" &&
    turnId &&
    event.content &&
    getActiveTurnOwner(mind, event.session) === process
  ) {
    const resultToolUseId =
      typeof event.metadata?.tool_use_id === "string" ? event.metadata.tool_use_id : undefined;
    const toolUseEventId = getToolUseEventId(mind, event.session, resultToolUseId);
    try {
      await linkToolResultToTurn(mind, turnId, event.content, toolUseEventId, {
        thread: event.session,
        sender: process,
      });
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
    // The text event's own turn and thread, as resolved above — the echo never looks the
    // turn up again (a `done` may already have closed it) and never borrows another's.
    echoTextToChannel(
      mind,
      event.channel,
      cleanContent,
      { turnId: turnId ?? undefined, thread: normalizeThread(event.session) },
      insertedId,
    ).catch((err) =>
      llog.error(`echo-text failed for ${mind} on ${event.channel}`, log.errorData(err)),
    );
  }

  // Track mind activity for the dashboard timeline.
  onMindEvent(mind, event.type, event.channel);

  // Turn failure: record a notice and flag the session as errored so the upcoming `done`
  // does NOT mark notices delivered (failures accumulate until a clean turn).
  if (event.type === "error" && event.session) {
    markErrored(mind, event.session, outstandingId(mind, event.session, event.messageId));
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

  if (done) {
    if (done.ends) {
      // Turn end: clear the persistent typing entries set at delivery (delivery-manager)
      // and push the update to web clients. This is the canonical mid-flight clear — do
      // not clear earlier (e.g. on text/outbound); typing means "on a turn", not "about
      // to send here". A `done` that ends no turn leaves the one running beside it be.
      const map = getTypingMap();
      publishTypingForChannels(map.deleteSender(mind), map);
      broadcast({ type: "mind_done", mind, summary: "Finished processing" });
    }
    // Retire the deliveries it covers and, if no turn runs on with nothing left to run,
    // free its slot.
    try {
      getDeliveryManager().sessionDone(mind, event.session, done.retired ?? [], done.releases);
    } catch (err) {
      if (!(err instanceof ManagerNotReadyError)) {
        llog.error(`delivery manager sessionDone failed for ${mind}`, log.errorData(err));
      }
    }
    if (done.closes) await completeTurnAndSummarize(mind, event, insertedId, done, process);
    // A variant's turn beside its parent's: nothing of the parent's to complete, but the
    // notices its own turn drained are delivered all the same.
    else if (done.ends && event.session) markDeliveredOnCleanTurn(mind, event.session, done);
  }

  // Record spend against the mind's cap and the install-wide cap. `cost_usd` is set
  // by priceUsageMetadata above; null means the turn couldn't be priced, which
  // accumulates nothing but marks the period's figure as incomplete.
  if (event.type === "usage" && event.metadata) {
    const costUsd = typeof event.metadata.cost_usd === "number" ? event.metadata.cost_usd : null;
    const sb = getSpendBudget();
    sb.recordUsage(mind, costUsd);
    if (event.session) {
      const { status, scope } = sb.checkBudget(mind);
      // A turn that jumps straight past the cap reports "exceeded" and skips the
      // warning — there is nothing left to warn about by then.
      // Acknowledge only once the notice is actually on record. Marking it delivered
      // first would mean a transient failure costs the mind the heads-up entirely —
      // silence being the exact failure this warning exists to prevent.
      if (status === "warning" && scope) {
        if (await recordSpendNotice(mind, event.session, scope, "warning")) {
          sb.acknowledgeWarning(mind, scope);
        }
      } else if (status === "exceeded" && scope && sb.noteExceeded(mind, scope)) {
        if (!(await recordSpendNotice(mind, event.session, scope, "exceeded"))) {
          sb.retractExceeded(mind, scope);
        }
      }
    }
  }

  return { turnId: turnId ?? undefined, insertedId };
}

/**
 * Dollars, to the cent — except a nonzero amount under a cent, which gets enough
 * decimals to not read as "$0.00 of your $0.00 budget" on a very small cap.
 */
export function usd(n: number): string {
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/**
 * When a spend period rolls over, phrased for a mind reading it mid-turn rather than
 * as a bare timestamp. A cap you can't tell the end of is a trapdoor, not a budget.
 */
function formatReset(resetAt: number | null): string {
  if (resetAt == null) return "when the period rolls over";
  const minutes = Math.max(0, Math.round((resetAt - Date.now()) / 60_000));
  if (minutes < 1) return "in under a minute";
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in about ${hours} hour${hours === 1 ? "" : "s"}`;
  return `in about ${Math.round(hours / 24)} days`;
}

/**
 * Record the 80% heads-up or the cap-reached notice. Names the cap, the spend so far,
 * and when the period resets — a mind that knows it is near its cap can finish a
 * thought and stop deliberately; one that doesn't just goes silent mid-sentence and
 * can't tell whether it broke or was stopped.
 */
async function recordSpendNotice(
  mind: string,
  session: string,
  scope: BudgetScope,
  status: "warning" | "exceeded",
): Promise<boolean> {
  try {
    const sb = getSpendBudget();
    const usage = scope === "system" ? sb.getSystemUsage() : sb.getUsage(mind);
    if (!usage) return false;
    const key = `${scope === "system" ? "system_" : ""}spend_${status}_notice` as const;
    const detail = await getPrompt(key, {
      spent: usd(usage.spentUsd),
      cap: usd(usage.capUsd),
      // Unpriced turns add nothing to the total, so the figure is a floor. Saying so
      // beats quoting an incomplete number as if it were exact.
      incomplete: usage.hasUnpricedTurns
        ? " Some turns this period couldn't be priced, so the real figure is a little higher than the one above."
        : "",
      resets: formatReset(sb.resetAt(mind, scope)),
    });
    if (status === "warning") {
      // The mind is still receiving at 80%, so a next turn is coming to drain this — but
      // not necessarily in the thread that crossed the threshold. Minds run per-session
      // threads (one per channel, the pi template's default), so a warning pinned to
      // `session` waits for a turn in *that* thread while the mind spends the rest of its
      // cap talking in others, and the heads-up arrives after the cap already bound — if
      // ever. Mind-level is the sentinel for exactly this: drained by whichever thread
      // turns next, the same reason the held-release summary uses it.
      // Only a notice that landed counts: the caller burns the once-per-period flag on
      // `true`, and a failed insert reported as success would spend the mind's one
      // heads-up on silence (#962).
      const id = await recordNotice({
        mind,
        thread: MIND_LEVEL_THREAD,
        kind: "budget",
        reason: `${scope}_spend_cap`,
        detail,
      });
      return id != null;
    }
    // The exceeded notice cannot ride the next-turn drain: from this moment inbound
    // messages are held, and an inbound message is what would have produced the next
    // turn. A mind whose only traffic is chat would go quiet with the explanation for
    // its silence queued behind the silence. So it is delivered immediately — one turn,
    // once per period, which is the whole point of a limit that is a heads-up rather
    // than a trapdoor. A sleeping mind's copy stays pending and flushes on wake, as any
    // immediate event does.
    const { id } = await deliverEvent(mind, {
      type: "budget",
      body: detail,
      thread: session,
      delivery: "immediate",
      meta: { subtype: "budget", reason: `${scope}_spend_cap` },
    });
    // Recorded, even if the POST failed — the row is pending and is redelivered on the
    // next wake or mind start, so the mind's one notification has not been spent.
    return id != null;
  } catch (err) {
    llog.error(`failed to record spend ${status} notice for ${mind}`, log.errorData(err));
    return false;
  }
}

/**
 * Complete the turn a `done` closes (see `readDone`), then mark drained notices delivered
 * and fire summarization.
 */
async function completeTurnAndSummarize(
  mind: string,
  event: MindEvent,
  insertedId: number | undefined,
  done: DoneState,
  process: string,
): Promise<void> {
  const completedTurnId = await completeTurn(mind, event.session, {
    turnId: done.turnId,
    owner: process,
  });
  if (event.session) markDeliveredOnCleanTurn(mind, event.session, done);
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
}
