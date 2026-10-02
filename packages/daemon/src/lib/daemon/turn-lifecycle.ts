import {
  captureReflection,
  clearDeliveredEvents,
  deliverEvent,
  drainEvents,
  MIND_LEVEL_THREAD,
  recordNotice,
  type SystemEvent,
} from "../chat/system-events.js";
import { getTypingMap, publishTypingForChannels } from "../chat/typing.js";
import { getDb } from "../db.js";
import { getDeliveryManager, tryGetDeliveryManager } from "../delivery/delivery-manager.js";
import { echoTextToChannel } from "../delivery/echo-text.js";
import { linkRunToTurn, linkToolResultToTurn } from "../delivery/message-delivery.js";
import { broadcast } from "../events/activity-events.js";
import { onMindEvent } from "../events/mind-activity-tracker.js";
import { publish as publishMindEvent } from "../events/mind-events.js";
import { getPrompt } from "../prompts.js";
import { mindHistory } from "../schema.js";
import log from "../util/logger.js";
import { classify } from "./error-classify.js";
import { ManagerNotReadyError } from "./manager-not-ready.js";
import { isProcessLive } from "./mind-manager.js";
import { type BudgetScope, getSpendBudget } from "./spend-budget.js";
import { resumeOnUsage, summarizeTurn } from "./summarizer.js";
import { SLOT_MAX_AGE_MS } from "./turn-slots.js";
import {
  activeOwners,
  adoptInterrupted,
  clearCoveredInterrupts,
  closedTurnFor,
  completeTurn,
  createTurn,
  drainedByDelivery,
  getActiveTurnId,
  getToolUseEventId,
  linkReportsToTurn,
  linkRowsToTurn,
  markClosing,
  markErrored,
  markStrayErrored,
  normalizeThread,
  recordClosedTurn,
  recordDrained,
  recordStrayDrained,
  takeDrained,
  takeErrored,
  touchTurn,
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
 * The delivery a mind's event names, if it is one the daemon delivered to that process on that
 * session and no `done` has covered yet — the only ids a turn's error flag or drained notices
 * are keyed by. Anything else a mind sends is read as naming no turn, so a mind can't grow the
 * daemon's per-delivery state with ids of its own, nor key a flag to another process's.
 */
function outstandingId(
  mind: string,
  session: string,
  messageId: string | undefined,
  process: string,
) {
  if (messageId === undefined) return undefined;
  try {
    return getDeliveryManager().isOutstanding(mind, session, messageId, process)
      ? messageId
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Drain a session's next-turn notices for a prompt of the turn of `messageId`, and record
 * what it drained against that turn. A notice already drained into a delivery `process`
 * still has outstanding — its `done` not yet in — is left out: the prompt is folded into
 * that turn, and the mind has been told (#1233). A notice held only by a variant's turn, or
 * by a drain that named no delivery, is not: that is another context. A drain on a thread
 * where `process` has neither a delivery nor a turn — a folded event it runs as a turn of its
 * own, before that turn opens — goes in its one stray record (see `knownThread`), and is not
 * held. Held notices are only skipped, never claimed, so if the turn holding one fails, a
 * later turn drains it again — one turn late, when the skipping prompt was the next turn's,
 * racing the holder's `done`.
 *
 * Once a `done` arrives its drains are no longer held, but they stay undelivered until its
 * clear commits; a prompt of the next turn drained in that gap is shown them again. That is
 * a repeat across two turns, never a loss.
 */
export async function drainNotices(
  mind: string,
  session: string,
  process: string,
  messageId?: string,
): Promise<SystemEvent[]> {
  const held: number[] = [];
  for (const [delivery, ids] of drainedByDelivery(mind, session, process)) {
    if (outstandingId(mind, session, delivery, process)) held.push(...ids);
  }
  const notices = await drainEvents(mind, session, undefined, held);
  const ids = notices.map((n) => n.id);
  if (knownThread(mind, session, process)) {
    recordDrained(mind, session, process, ids, outstandingId(mind, session, messageId, process));
  } else recordStrayDrained(process, session, ids);
  return notices;
}

/**
 * Whether `process` has a delivery outstanding or a turn running on the thread: the only
 * threads per-session error and drain state is kept for. Anything else is a thread name the
 * mind chose, and keeping state for each would let a mind grow the daemon's memory by naming
 * threads (#1220): it gets one stray record per process (`strayThreads`).
 */
function knownThread(mind: string, session: string, process: string): boolean {
  if (getActiveTurnId(mind, session, process)) return true;
  try {
    return getDeliveryManager().hasOutstanding(mind, session, process);
  } catch {
    return false;
  }
}

/** What a `done` does to its session, decided the moment it arrives (see `readDone`). */
type DoneState = {
  /** The `done` ends a turn of its process's. */
  ends: boolean;
  /** Another live process of the mind — a parent or a variant — runs a turn on the thread. */
  beside: boolean;
  /** Its process's active turn it closes, as it stood when the `done` arrived. */
  turnId: string | undefined;
  /** The turn was recorded already complete by this `done`, which found none running. */
  bornClosed?: boolean;
  /** No turn runs on once it is handled, so the session's slot may go back. */
  releases: boolean;
  /** The outstanding deliveries it finishes (see `DeliveryManager.coveredBy`). */
  retired: string[] | undefined;
  /** The notice ids the ended turn drained. */
  drained: number[];
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
 * A `done` closes only its own process's turn: a variant's turn beside its parent's on the
 * same thread is its own, and neither's `done` ends the other's (#1177). A `done` that ends
 * a turn takes its process's drained notices and error flags of the deliveries it finished,
 * and those that named none, before anything awaits, so a drain for the next turn is never
 * claimed by this one's. A `done` that ends no turn drops its failed deliveries' flags,
 * whose turns never ran.
 */
function readDone(mind: string, event: MindEvent, process: string): DoneState {
  const session = event.session;
  const legacy = event.covers === undefined;
  const ends = event.endsTurn !== false;
  const turnId = getActiveTurnId(mind, session, process);
  // The slot is the thread's, whichever process holds it: a `done` frees it when it ends a
  // turn and no other process's runs on beside it — or, ending none, when no turn runs at all:
  // the one it failed beside has already ended, and its own `done` could not free what this
  // delivery held. A turn beside counts only while its process runs and it has been heard
  // from within a slot's lifetime: one that never gets its `done` must not hold the thread.
  const live = activeOwners(mind, session, SLOT_MAX_AGE_MS).filter(isProcessLive);
  const beside = live.some((owner) => owner !== process);
  const releases = (ends && !beside) || live.length === 0;
  let retired: string[] | undefined;
  try {
    const dm = getDeliveryManager();
    retired = dm.coveredBy(mind, session, {
      process,
      messageId: event.messageId,
      covers: event.covers,
      endsTurn: ends,
    });
    // Finished from this moment, though `sessionDone` retires them only after this `done`
    // is recorded: a turn opening meanwhile must not take them as its own (`foldedRows`).
    if (session) dm.markRetiring(mind, session, retired);
  } catch (err) {
    if (!(err instanceof ManagerNotReadyError)) {
      llog.error(`delivery manager coveredBy failed for ${mind}`, log.errorData(err));
    }
  }
  const state = { ends, beside, turnId, releases, retired };
  if (!session) return { ...state, drained: [], errored: false };

  const named = [...new Set([...(event.covers ?? []), ...(retired ?? [])])];
  if (event.messageId !== undefined) named.push(event.messageId);
  if (!ends) {
    takeDrained(mind, session, process, named, false);
    takeErrored(mind, session, process, named, false);
    return { ...state, drained: [], errored: false };
  }
  // A template that predates `covers` reads its process's whole session, as it always did.
  const ids = legacy ? undefined : named;
  return {
    ...state,
    drained: takeDrained(mind, session, process, ids),
    errored: takeErrored(mind, session, process, ids),
  };
}

/**
 * On a turn that completed without an error event, mark the notices the mind actually
 * drained this turn as delivered. If the turn errored, leave them queued so they reach
 * the mind on its next genuinely successful turn.
 */
function markDeliveredOnCleanTurn(mind: string, session: string, done: DoneState): void {
  if (!done.errored && done.drained.length > 0) {
    clearDeliveredEvents(mind, session, done.drained).catch((err) =>
      llog.warn(`failed to clear delivered notices for ${mind}:${session}`, log.errorData(err)),
    );
  }
}

/**
 * Move the rows of `process`'s outstanding deliveries on the session — only `ids`, if given
 * — to a turn opening now. They are what it runs: a delivery that folded into the previous
 * turn and was not covered by its `done` runs as a turn of its own (#1207), and the rows it
 * was linked to that turn with move here, the first of them the trigger.
 */
async function adoptFolded(
  mind: string,
  session: string | undefined,
  process: string,
  turnId: string,
  ids?: string[],
): Promise<void> {
  if (!session) return;
  const dm = tryGetDeliveryManager();
  if (!dm) return;
  const folded = dm.foldedRows(mind, session, process, ids, turnId);
  await linkRowsToTurn(turnId, folded.rows, { from: folded.from });
}

/**
 * What names a turn's own late reports: the deliveries its `done` retired, and the id the
 * `done` itself carries — an event's or a wake batch's turn has no daemon delivery id, and
 * its `usage` names the same id as its `done`. The mind's own id, so it is kept per mind
 * (see `closedTurns`): a mind can only crowd out its own.
 */
function turnDeliveries(event: MindEvent, done: DoneState): string[] {
  // A `done` without `covers` retires everything its process had outstanding, including a
  // delivery it will run next as a turn of its own: only what it names is this turn's.
  const ids = event.covers === undefined ? [] : [...(done.retired ?? [])];
  if (event.messageId !== undefined && !ids.includes(event.messageId)) ids.push(event.messageId);
  return ids;
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
 * server sent the event. Turns are its own: a variant's events on its parent's thread land in
 * the variant's turn there, never the parent's (#1177).
 *
 * Returns the resolved `turnId` (if any) and the persisted mind_history `insertedId`.
 */
export async function handleMindEvent(
  mind: string,
  event: MindEvent,
  process: string = mind,
): Promise<{ turnId?: string; insertedId?: number }> {
  // Look up this process's active turn for the event; create one if missing for substantive
  // events. Keyed by the event's own thread and process from the start — never borrowed from
  // a sibling thread, nor from a parent or variant on the same one.
  let turnId = getActiveTurnId(mind, event.session, process);
  // Synchronous with the `done`'s arrival — see readDone.
  const done = event.type === "done" ? readDone(mind, event, process) : undefined;
  // A `done` that ends no turn isn't the running turn's end, and must not be recorded as
  // one — the wedged-turn sweep reads a turn's `done` rows as its having ended.
  if (done && !done.ends) turnId = undefined;
  if (done?.ends && done.turnId) {
    markClosing(mind, event.session, process, done.turnId, turnDeliveries(event, done));
    clearCoveredInterrupts(done.turnId, done.retired ?? []);
  }
  // What a turn reports can be handled after its `done` — the mind POSTs its events
  // concurrently (#1298). Each names its delivery, so it lands on that delivery's turn,
  // closing or closed, whatever has opened on the thread since — never on a new one.
  const closedTurn = done ? undefined : closedTurnFor(event.session, process, event.messageId);
  if (closedTurn) turnId = closedTurn;
  if (!turnId && SUBSTANTIVE_TYPES.has(event.type)) {
    turnId = await createTurn(mind, event.session, process);
    if (!turnId) {
      llog.warn(`skipping turn tracking for ${mind}: createTurn failed`);
    } else {
      publishMindEvent(mind, { mind, type: "turn_created", turnId });
      // What it runs, by the rows the daemon recorded — never a sweep of untagged rows by a
      // channel or thread the mind names (#1178).
      await adoptFolded(mind, event.session, process, turnId);
      // An interrupted turn's message, if the delivery that interrupted it started this one.
      await adoptInterrupted(mind, event.session, process, turnId);
    }
  }
  // A turn nothing opened — a `silent` mind's, folded in on the daemon's side but run as a
  // turn of its own (#1298) — is recorded by the `done` that names its deliveries: already
  // complete, so no event racing in can join it. Its rows, and the usage that named those
  // deliveries, move to it.
  if (!turnId && done?.ends && event.session && done.retired?.length) {
    turnId = await recordClosedTurn(mind, event.session, process, turnDeliveries(event, done));
    if (turnId) {
      done.turnId = turnId;
      done.bornClosed = true;
      await adoptFolded(mind, event.session, process, turnId, done.retired);
      await linkReportsToTurn(mind, event.session, turnId, turnDeliveries(event, done));
      // And what it sent while it ran with no turn to stamp, before it is judged quiet (#1320).
      await linkRunToTurn(mind, process, event.session, turnId, turnDeliveries(event, done));
      await adoptInterrupted(mind, event.session, process, turnId);
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

  // A `done` handled while this event awaited may have recorded the turn it names since
  // (`recordClosedTurn`): look again, so the event lands on it rather than on nothing.
  if (!turnId && !done) turnId = closedTurnFor(event.session, process, event.messageId);

  // A report naming no delivery, with no turn to land on — a `silent` run's context before
  // the mind knows which delivery it runs — names the one its process is running, so the
  // turn recorded at that delivery's `done` takes it (`linkReportsToTurn`, #1320).
  const messageId =
    event.messageId ??
    (turnId || done || !event.session
      ? undefined
      : tryGetDeliveryManager()?.runningDelivery(mind, event.session, process));

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
        message_id: messageId ?? null,
        content: cleanContent ?? null,
        metadata: event.metadata ? JSON.stringify(event.metadata) : null,
        turn_id: turnId ?? null,
      })
      .returning({ id: mindHistory.id });
    insertedId = result[0]?.id;
    // A quiet turn held for its usage can now be summarized (see summarizer's awaitingUsage).
    if (event.type === "usage" && turnId) resumeOnUsage(turnId);
    if (turnId) touchTurn(turnId);
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
    trackToolUse(mind, event.session, process, insertedId, toolUseId);
  }

  // Fallback linking via correlation markers. Sends and command activities are attributed
  // at send/publish time from the caller's thread (api/chat.ts, publishTurnActivity);
  // linkToolResultToTurn fills in what that couldn't: a send from this thread made before
  // its turn existed (re-published once, with the turn), or an unstamped activity of this
  // mind. It never overwrites a turn or crosses threads — or processes: `turnId` is this
  // process's own, and it links only what this process sent.
  if (event.type === "tool_result" && turnId && event.content) {
    const resultToolUseId =
      typeof event.metadata?.tool_use_id === "string" ? event.metadata.tool_use_id : undefined;
    const toolUseEventId = getToolUseEventId(mind, event.session, process, resultToolUseId);
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
  // does NOT mark notices delivered (failures accumulate until a clean turn). On a thread
  // where this process has neither a delivery nor a turn, it is its one stray record (#1220).
  if (event.type === "error" && event.session) {
    // An error naming a delivery whose `done` has been handled — even while this event
    // awaited — belongs to that finished turn: the two were POSTed concurrently (#1298), and
    // it flags nothing that runs next.
    const session = event.session;
    const finished = closedTurnFor(session, process, event.messageId);
    if (!finished && knownThread(mind, session, process)) {
      markErrored(mind, session, process, outstandingId(mind, session, event.messageId, process));
    } else if (!finished) markStrayErrored(process, session);
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
    if (done.ends && !done.beside) {
      // Turn end: clear the persistent typing entries set at delivery (delivery-manager)
      // and push the update to web clients. This is the canonical mid-flight clear — do
      // not clear earlier (e.g. on text/outbound); typing means "on a turn", not "about
      // to send here". Typing is the mind's, not a process's: a `done` that ends no turn — a
      // failed delivery's — or one beside another live process's turn on the thread — a
      // variant's beside its parent's — leaves the turn running beside it its indicator.
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
    if (done.ends) {
      // A turn of its own to complete — or, with none, a thread no other process is running
      // a turn on either, to summarize by its range of rows. Beside another process's turn,
      // that range is the other's: only the notices this process drained are delivered.
      if (done.turnId || !done.beside) {
        await completeTurnAndSummarize(mind, event, process, insertedId, done);
      } else if (event.session) markDeliveredOnCleanTurn(mind, event.session, done);
    }
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
  process: string,
  insertedId: number | undefined,
  done: DoneState,
): Promise<void> {
  const completedTurnId = done.bornClosed
    ? done.turnId
    : await completeTurn(mind, event.session, process, { turnId: done.turnId });
  if (event.session) markDeliveredOnCleanTurn(mind, event.session, done);
  // If this turn was triggered by an immediate system event (exact match via the
  // turn's trigger_event_id), record its final text as the event's reflection
  // (logged only — delivered nowhere).
  captureReflection(mind, completedTurnId).catch((err) =>
    llog.warn("failed to capture event reflection", log.errorData(err)),
  );
  if (insertedId != null) {
    summarizeTurn(mind, event.session, event.channel, insertedId, completedTurnId, undefined, {
      onDone: true,
      handOff: process,
    }).catch((err) => llog.error("turn summarization failed", log.errorData(err)));
  }
}
