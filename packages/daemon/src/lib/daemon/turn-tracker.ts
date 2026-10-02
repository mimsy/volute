import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb } from "../db.js";
import { publish as publishMindEvent } from "../events/mind-events.js";
import { mindHistory, turns } from "../schema.js";
import log from "../util/logger.js";
import { forgetAwaitingUsage, summarizeTurn } from "./summarizer.js";

const tlog = log.child("turn-tracker");

type ActiveTurn = {
  turnId: string;
  lastToolUseEventId: number | undefined;
  /** SDK tool_use id → mind_history event id, so a tool_result links to its own tool_use. */
  toolUseEventIds: Map<string, number>;
  /**
   * The process whose events opened the turn — the mind, or one of its variants. Turns
   * are keyed by base name, so a variant's thread shares its parent's key; a send is
   * only stamped with a turn its own process opened (see `turnStamp`).
   */
  owner: string;
  /**
   * A `done` has closed it and its completion is being recorded. It is no longer the active
   * turn to anything — not a delivery, not another `done`, not an event, which belong to the
   * next — only its own late `usage` still finds it, by delivery (`closedTurnFor`).
   */
  closing?: boolean;
};

/**
 * In-memory map of active turns, keyed by `mind:thread` (or `mind:*` for events that carry
 * no thread). Every lookup is exact: a thread never resolves to another key's turn. A
 * fallback from a thread to the sessionless slot once credited one thread's send to a
 * sibling thread's turn (#1173).
 */
const activeTurns = new Map<string, ActiveTurn>();

/**
 * Turns a `done` has completed, by `mind:thread:delivery` for each delivery the `done`
 * retired. A turn's `usage` is a separate POST the daemon may handle after its `done`
 * (#1298); it names its delivery, so it finds its own turn here exactly, whatever has opened
 * on the thread since. Capped: entries are only ever needed for moments, and most are never
 * looked up.
 */
const closedTurns = new Map<string, Map<string, string>>();
/** Per mind, so no mind's reports can crowd out another's. */
const CLOSED_TURNS_PER_MIND = 64;

function closedKey(session: string | null | undefined, delivery: string): string {
  return `${normalizeThread(session) ?? "*"}:${delivery}`;
}

/** The deliveries a `done` named for this completed turn, as far as they are remembered. */
export function deliveriesOf(
  mind: string,
  session: string | null | undefined,
  turnId: string,
): string[] {
  const prefix = closedKey(session, "");
  const ids: string[] = [];
  for (const [k, t] of closedTurns.get(mind) ?? []) {
    if (t === turnId && k.startsWith(prefix)) ids.push(k.slice(prefix.length));
  }
  return ids;
}

/** The completed turn that ran this delivery, if a `done` named it recently. */
export function closedTurnFor(
  mind: string,
  session: string | null | undefined,
  delivery: string | undefined,
): string | undefined {
  return delivery === undefined
    ? undefined
    : closedTurns.get(mind)?.get(closedKey(session, delivery));
}

/**
 * A thread name as the daemon records it: undefined for no thread. "" and "*" are no
 * thread — "*" is the sessionless slot's own key, so a thread by that name would alias it.
 */
export function normalizeThread(thread: string | null | undefined): string | undefined {
  return thread && thread !== "*" ? thread : undefined;
}

function key(mind: string, session?: string | null): string {
  return `${mind}:${normalizeThread(session) ?? "*"}`;
}

/**
 * Per `mind:thread`, the turns that have seen an `error` event since their `done`, by the
 * delivery the error named ("" for one that named none). Used to distinguish a failed turn
 * from a clean one: failure notices are only marked delivered after a turn that completed
 * WITHOUT an error, so they accumulate across a full outage and reach the mind on its next
 * genuinely successful turn. Keyed by delivery, an error in one turn is never charged to
 * another on the same session. Callers key only by deliveries the daemon itself has
 * outstanding (see turn-lifecycle), so a mind can't grow this with ids of its own.
 */
const erroredSessions = new Map<string, Set<string>>();

/**
 * Per `mind:thread`, the notice ids the pre-prompt hook drained, by the delivery whose turn
 * drained them ("" when the hook named none — a template that predates the field). A clean
 * turn marks exactly these delivered, so a notice created mid-turn — or one a prompt was not
 * shown because another turn still held it (#1233) — isn't lost before the mind reads it;
 * keyed by delivery, the next turn's drain can never be claimed by this turn's `done`,
 * however the two requests interleave (#1207).
 */
const drainedNotices = new Map<string, Map<string, Set<number>>>();

/** Flag that the turn of `messageId` (or, naming none, the session's) hit an error. */
export function markErrored(mind: string, session?: string | null, messageId?: string): void {
  const k = key(mind, session);
  let byDelivery = erroredSessions.get(k);
  if (!byDelivery) {
    byDelivery = new Set();
    erroredSessions.set(k, byDelivery);
  }
  byDelivery.add(messageId ?? "");
}

/**
 * Return whether any of the turns of `messageIds` errored, clearing every flag read. The
 * session's unkeyed flag (an error that named no turn) is read too unless `unkeyed` is
 * false; without `messageIds`, every flag on the session is.
 */
export function takeErrored(
  mind: string,
  session?: string | null,
  messageIds?: string[],
  unkeyed = true,
): boolean {
  const k = key(mind, session);
  const byDelivery = erroredSessions.get(k);
  if (!byDelivery) return false;
  let errored = false;
  if (!messageIds) {
    errored = byDelivery.size > 0;
    byDelivery.clear();
  } else {
    if (unkeyed) errored = byDelivery.delete("");
    for (const id of messageIds) errored = byDelivery.delete(id) || errored;
  }
  if (byDelivery.size === 0) erroredSessions.delete(k);
  return errored;
}

/** Record the notice ids drained for the turn of `messageId` (see drainedNotices). */
export function recordDrained(
  mind: string,
  session: string,
  ids: number[],
  messageId?: string,
): void {
  if (ids.length === 0) return;
  const k = key(mind, session);
  let byDelivery = drainedNotices.get(k);
  if (!byDelivery) {
    byDelivery = new Map();
    drainedNotices.set(k, byDelivery);
  }
  const d = messageId ?? "";
  const drained = byDelivery.get(d) ?? new Set();
  for (const id of ids) drained.add(id);
  byDelivery.set(d, drained);
}

/** The notice ids drained so far, by each delivery that named itself, on the session. */
export function drainedByDelivery(mind: string, session: string): [string, Set<number>][] {
  return [...(drainedNotices.get(key(mind, session)) ?? [])].filter(([d]) => d !== "");
}

/**
 * Take the notice ids drained for any of the turns of `messageIds` — and, unless `unkeyed`
 * is false, for no turn in particular — or, without `messageIds`, for any turn on the
 * session, clearing each.
 */
export function takeDrained(
  mind: string,
  session: string,
  messageIds?: string[],
  unkeyed = true,
): number[] {
  const k = key(mind, session);
  const byDelivery = drainedNotices.get(k);
  if (!byDelivery) return [];
  const keys = messageIds ? [...(unkeyed ? [""] : []), ...messageIds] : [...byDelivery.keys()];
  const taken = new Set<number>();
  for (const d of keys) {
    const drained = byDelivery.get(d);
    if (!drained) continue;
    byDelivery.delete(d);
    for (const id of drained) taken.add(id);
  }
  if (byDelivery.size === 0) drainedNotices.delete(k);
  return [...taken];
}

/**
 * Create a turn for a mind's thread (or reuse the thread's active one). Keyed by the
 * thread from the start and recorded with it; with no thread, keyed as `mind:*`.
 *
 * The in-memory map entry is set BEFORE the DB insert to prevent a race where
 * two concurrent substantive events both pass the existence check. If the DB
 * insert fails, the entry is rolled back.
 */
export async function createTurn(
  mind: string,
  session?: string | null,
  owner: string = mind,
): Promise<string | undefined> {
  const k = key(mind, session);
  const existing = activeTurns.get(k);
  if (existing && !existing.closing) return existing.turnId;

  const turnId = randomUUID();
  const entry: ActiveTurn = {
    turnId,
    lastToolUseEventId: undefined,
    toolUseEventIds: new Map(),
    owner,
  };
  // Reserve the slot synchronously to prevent concurrent callers from creating duplicates
  activeTurns.set(k, entry);

  try {
    const db = await getDb();
    await db
      .insert(turns)
      .values({ id: turnId, mind, thread: normalizeThread(session) ?? null, status: "active" });
  } catch (err) {
    tlog.error(`failed to create turn for ${mind}`, log.errorData(err));
    // Roll back the in-memory reservation
    if (activeTurns.get(k) === entry) activeTurns.delete(k);
    return undefined;
  }

  return turnId;
}

/** The process that opened this mind+thread's active turn (see `ActiveTurn.owner`). */
export function getActiveTurnOwner(mind: string, session?: string | null): string | undefined {
  const entry = activeTurns.get(key(mind, session));
  return entry?.closing ? undefined : entry?.owner;
}

/** Get the active turn ID for exactly this mind+thread (`mind:*` when there is none). */
export function getActiveTurnId(mind: string, session?: string | null): string | undefined {
  const entry = activeTurns.get(key(mind, session));
  return entry?.closing ? undefined : entry?.turnId;
}

/**
 * Open the turn a delivery starts: called when the delivery takes the session's turn slot,
 * before it is POSTed, so the turn exists — with its trigger — before the mind sees the
 * message. This is what gives a turn a row when the mind emits nothing that would open one:
 * a `silent` mind filters every such event (#1298). It rests on the daemon's own evidence,
 * the slot it just gave the delivery, never on a thread the mind names.
 *
 * A turn already open on the thread is joined if the delivered process opened it (the mind
 * started work there on its own); one another process opened — a variant shares its
 * parent's turn key — is not this delivery's, and nothing opens. `created` says whether
 * this call made the turn, and so whether a refused POST may take it back (`unlinkRefused`).
 *
 * `mind` is the base name; `process` the mind or variant delivered to. A delivery with no
 * thread opens nothing — the mind picks where it runs.
 */
export async function openDeliveredTurn(
  mind: string,
  session: string | null | undefined,
  process: string,
): Promise<{ turnId: string; created: boolean } | undefined> {
  if (!normalizeThread(session)) return undefined;
  const existing = activeTurns.get(key(mind, session));
  if (existing && !existing.closing) {
    // Joined, even one whose own delivery's POST went unanswered: the mind may be running
    // it, and folding in is safe where a wrong deletion is not.
    return existing.owner === process ? { turnId: existing.turnId, created: false } : undefined;
  }
  const turnId = await createTurn(mind, session, process);
  if (!turnId) return undefined;
  publishMindEvent(mind, { mind, type: "turn_created", turnId });
  return { turnId, created: true };
}

/**
 * Per `mind:thread`, the rows of turns the summarizer took back as interrupted — a message
 * the mind was given but whose turn produced nothing before it ended — while no turn runs
 * on the thread to take them. The mind's next turn there is normally its answer, so that
 * turn adopts them (`adoptInterrupted`) — if it comes soon: after `INTERRUPTED_ROWS_MS` the
 * thread has moved on, and they are left unlinked, as on main.
 */
const interruptedRows = new Map<string, { ids: number[]; at: number }>();
const INTERRUPTED_ROWS_PER_THREAD = 64;
const INTERRUPTED_ROWS_MS = 2 * 60_000;

/**
 * Turns a delivery was POSTed to interrupt: they end without answering what they were given,
 * however much output the model had produced, so the summarizer takes them back rather than
 * keeping them as quiet turns. Capped; an entry is only needed until its turn is summarized.
 */
const interruptedTurns = new Map<string, Set<string>>();

/**
 * A delivery POSTed to interrupt this turn. Kept per delivery: one that turns out never to
 * have arrived (`unmarkInterrupted`) can't undo another's that did, and one the turn's own
 * `done` covers didn't cut it off — the mind took it into the same run (pi does) — so it
 * is cleared there (`clearCoveredInterrupts`).
 */
export function markInterrupted(turnId: string, deliveryId: string): void {
  const by = interruptedTurns.get(turnId) ?? new Set<string>();
  by.add(deliveryId);
  interruptedTurns.set(turnId, by);
  if (interruptedTurns.size > 256) {
    interruptedTurns.delete(interruptedTurns.keys().next().value!);
  }
}

/** Whether a delivery interrupted this turn (see `markInterrupted`). */
export function wasInterrupted(turnId: string): boolean {
  return (interruptedTurns.get(turnId)?.size ?? 0) > 0;
}

/**
 * Whether a turn was started by a message — its trigger an `inbound` row. Only such a turn
 * is an answer an interrupted message can join: adopting one into a turn an event or the
 * mind itself started would add a sender to a turn that never ran it, and authority is
 * read off a turn's senders (#433).
 */
async function startedByMessage(turnId: string): Promise<boolean> {
  const db = await getDb();
  const row = await db
    .select({ type: mindHistory.type })
    .from(turns)
    .innerJoin(mindHistory, eq(mindHistory.id, turns.trigger_event_id))
    .where(eq(turns.id, turnId))
    .get();
  return row?.type === "inbound";
}

/**
 * Hand an interrupted turn's rows, taken back just as it ended, to the next turn on its
 * thread: the one already running there, if a message started it (an interrupting one's),
 * or else the next to open soon (`adoptInterrupted`). Never the trigger: that turn's is its
 * own message. Never throws.
 */
export async function holdInterrupted(
  mind: string,
  session: string | null | undefined,
  rowIds: number[],
): Promise<void> {
  if (!normalizeThread(session) || rowIds.length === 0) return;
  const running = getActiveTurnId(mind, session);
  if (running) {
    try {
      if (await startedByMessage(running)) {
        await linkRowsToTurn(running, rowIds, { trigger: false });
        return;
      }
    } catch (err) {
      tlog.warn(`failed to hand interrupted rows to turn ${running}`, log.errorData(err));
    }
    // Not (yet) known to be a message's — its trigger may be on its way: held for it.
  }
  const k = key(mind, session);
  const prior = interruptedRows.get(k)?.ids ?? [];
  interruptedRows.set(k, {
    ids: [...prior, ...rowIds].slice(-INTERRUPTED_ROWS_PER_THREAD),
    at: Date.now(),
  });
}

/**
 * Give a turn a message just started on its thread — its trigger already linked — what an
 * interrupted turn there left, if that was recently (see `interruptedRows`). Only rows still
 * unlinked, and never the trigger. Never throws.
 */
export async function adoptInterrupted(
  mind: string,
  session: string | null | undefined,
  turnId: string,
): Promise<void> {
  const k = key(mind, session);
  const held = interruptedRows.get(k);
  if (!held) return;
  interruptedRows.delete(k);
  if (Date.now() - held.at > INTERRUPTED_ROWS_MS) return;
  try {
    if (await startedByMessage(turnId)) {
      await linkRowsToTurn(turnId, held.ids, { trigger: false });
    }
  } catch (err) {
    tlog.warn(`failed to adopt interrupted rows into turn ${turnId}`, log.errorData(err));
  }
}

/** A delivery that would have interrupted a turn never reached the mind: it didn't. */
export function unmarkInterrupted(turnId: string, deliveryId: string): void {
  const by = interruptedTurns.get(turnId);
  by?.delete(deliveryId);
  if (by?.size === 0) interruptedTurns.delete(turnId);
}

/** The turn's `done` covers these deliveries: none of them cut it off. */
export function clearCoveredInterrupts(turnId: string, covered: string[]): void {
  for (const id of covered) unmarkInterrupted(turnId, id);
}

/**
 * Link a delivery's own `inbound`/`event` history rows to the turn it runs in — exactly
 * them, never a sweep of the channel's untagged history — and make the first of them the
 * turn's trigger if it has none. `rowIds` are in the order the mind was given them. A row
 * another turn holds is left, and is never the trigger — unless it is held by one of
 * `from`, the turns folded deliveries were linked to on their ack (see
 * `DeliveryManager.foldedRows`).
 * `trigger: false` links without touching the trigger: a delivery that folded into a
 * running turn did not start it. Never throws: the message was received, and a missing
 * link costs only attribution.
 */
export async function linkRowsToTurn(
  turnId: string,
  rowIds: (number | undefined)[],
  opts: { trigger?: boolean; from?: string[] } = {},
): Promise<void> {
  const ids = rowIds.filter((id): id is number => id != null);
  if (ids.length === 0) return;
  try {
    const db = await getDb();
    const unheld = opts.from?.length
      ? or(isNull(mindHistory.turn_id), inArray(mindHistory.turn_id, opts.from))
      : isNull(mindHistory.turn_id);
    const linked = new Set(
      (
        await db
          .update(mindHistory)
          .set({ turn_id: turnId })
          .where(and(inArray(mindHistory.id, ids), unheld))
          .returning({ id: mindHistory.id })
      ).map((r) => r.id),
    );
    const first = ids.find((id) => linked.has(id));
    if (first === undefined || opts.trigger === false) return;
    await db
      .update(turns)
      .set({ trigger_event_id: first })
      .where(and(eq(turns.id, turnId), sql`${turns.trigger_event_id} IS NULL`));
  } catch (err) {
    tlog.warn(`failed to link delivered rows to turn ${turnId}`, log.errorData(err));
  }
}

/**
 * Record a turn that has already ended: one a `done` names but nothing opened, because the
 * mind emitted nothing that would (#1298). Written complete and never made active, so no
 * event arriving meanwhile can join it; `deliveries` find it afterwards (`closedTurnFor`).
 */
export async function recordClosedTurn(
  mind: string,
  session: string,
  process: string,
  deliveries: string[],
): Promise<string | undefined> {
  const turnId = randomUUID();
  try {
    const db = await getDb();
    await db
      .insert(turns)
      .values({ id: turnId, mind, thread: normalizeThread(session) ?? null, status: "complete" });
  } catch (err) {
    tlog.error(`failed to record turn for ${mind} (${process})`, log.errorData(err));
    return undefined;
  }
  rememberClosed(mind, session, turnId, deliveries);
  publishMindEvent(mind, { mind, type: "turn_created", turnId });
  return turnId;
}

/**
 * Link what the mind reported against `deliveries` before their turn was recorded — a
 * `usage` or `error` that named one, with no turn to land on — to that turn. Never throws.
 */
export async function linkReportsToTurn(
  mind: string,
  session: string,
  turnId: string,
  deliveries: string[],
): Promise<void> {
  try {
    const db = await getDb();
    await db
      .update(mindHistory)
      .set({ turn_id: turnId })
      .where(
        and(
          eq(mindHistory.mind, mind),
          eq(mindHistory.thread, session),
          inArray(mindHistory.message_id, deliveries),
          isNull(mindHistory.turn_id),
        ),
      );
  } catch (err) {
    tlog.warn(`failed to link reports to turn ${turnId}`, log.errorData(err));
  }
}

/**
 * A POST whose connection was refused: nothing listened on the mind's port, so the mind
 * never got it — the same as one never sent, and its turn is taken back. Unlike a POST that
 * failed to answer (a reset, a timeout), which the mind may have read and be running (#1327).
 * Unlike an HTTP rejection too, which the mind did receive: a refused fold has not been read.
 */
export function isConnectionRefused(err: unknown): boolean {
  return (err as { cause?: { code?: unknown } } | undefined)?.cause?.code === "ECONNREFUSED";
}

/**
 * Take back a delivery the mind refused — a definite rejection, never a POST that merely
 * failed to answer, which the mind may be running. Its own rows leave `turnId`; if this
 * delivery opened the turn (`created`) and nothing else is in it, the turn goes too. The
 * mind's own rows are never touched. Never throws.
 */
export async function unlinkRefused(
  mind: string,
  session: string | null | undefined,
  turnId: string,
  rowIds: (number | undefined)[],
  created: boolean,
): Promise<void> {
  const ids = rowIds.filter((id): id is number => id != null);
  // Synchronously, before the slot this refusal freed can be taken: a turn this delivery
  // opened is no longer the thread's, so the next delivery opens its own.
  const k = key(mind, session);
  if (created && activeTurns.get(k)?.turnId === turnId) activeTurns.delete(k);
  try {
    const db = await getDb();
    if (ids.length > 0) {
      await db
        .update(mindHistory)
        .set({ turn_id: null })
        .where(and(inArray(mindHistory.id, ids), eq(mindHistory.turn_id, turnId)));
      await db
        .update(turns)
        .set({ trigger_event_id: null })
        .where(and(eq(turns.id, turnId), inArray(turns.trigger_event_id, ids)));
    }
    if (!created) return;
    // The turn never ran. A delivery that folded into it meanwhile starts a turn of its own
    // mind-side, and is linked there when that opens (`foldedRows`): its rows leave too.
    await db
      .update(mindHistory)
      .set({ turn_id: null })
      .where(and(eq(mindHistory.turn_id, turnId), inArray(mindHistory.type, ["inbound", "event"])));
    const rest = await db
      .select({ id: mindHistory.id })
      .from(mindHistory)
      .where(eq(mindHistory.turn_id, turnId))
      .get();
    if (rest) {
      // Something of the mind's own landed in it: it stays, ended rather than running.
      await db.update(turns).set({ status: "complete" }).where(eq(turns.id, turnId));
      return;
    }
    await db.delete(turns).where(eq(turns.id, turnId));
    publishMindEvent(mind, { mind, type: "turn_discarded", turnId });
  } catch (err) {
    tlog.warn(`failed to take back refused delivery from turn ${turnId}`, log.errorData(err));
  }
}

/** The turn `process` is running on the thread, if it is running one — folds join it. */
export function runningTurnOf(
  mind: string,
  session: string | null | undefined,
  process: string,
): string | undefined {
  const entry = activeTurns.get(key(mind, session));
  return entry && !entry.closing && entry.owner === process ? entry.turnId : undefined;
}

/**
 * Record a tool_use event ID for a mind+session. When the SDK's `toolUseId` is known it's
 * also indexed so the matching tool_result can resolve its exact source (parallel tool calls
 * in one turn would otherwise all collapse onto "the last tool_use").
 */
export function trackToolUse(
  mind: string,
  session: string | null | undefined,
  eventId: number,
  toolUseId?: string,
): void {
  const entry = activeTurns.get(key(mind, session));
  if (!entry) return;
  entry.lastToolUseEventId = eventId;
  if (toolUseId) entry.toolUseEventIds.set(toolUseId, eventId);
}

/** Get the last tool_use event ID for a mind+session. */
export function getLastToolUseEventId(mind: string, session?: string | null): number | undefined {
  return activeTurns.get(key(mind, session))?.lastToolUseEventId;
}

/**
 * Resolve the source tool_use event ID for a tool_result, preferring an exact match on the
 * SDK `toolUseId`. Falls back to the last tool_use in the turn when the id is absent (older
 * templates) or unknown, preserving prior behavior.
 */
export function getToolUseEventId(
  mind: string,
  session: string | null | undefined,
  toolUseId?: string,
): number | undefined {
  const entry = activeTurns.get(key(mind, session));
  if (!entry) return undefined;
  if (toolUseId) {
    const id = entry.toolUseEventIds.get(toolUseId);
    if (id != null) return id;
  }
  return entry.lastToolUseEventId;
}

/**
 * Mark a turn as complete on a `done`. Returns the turnId (or undefined if none was active).
 * A `done` closes exactly its own thread's turn; only a sessionless `done` closes the
 * sessionless `mind:*` turn — a thread ending never ends an unrelated one.
 */
export async function completeTurn(
  mind: string,
  session?: string | null,
  /**
   * Complete it only if it is this turn — none, if it is undefined. A `done` decides what
   * it closes on arrival; by the time it completes, a turn opened since (another process's,
   * or the next queued one's) is not its to end.
   */
  only?: { turnId: string | undefined },
): Promise<string | undefined> {
  const k = key(mind, session);
  // The turn the `done` closed — which a delivery may already have replaced as the active
  // one (see `closing`) — or, with no `only`, whatever is active.
  const turnId = only ? only.turnId : activeTurns.get(k)?.turnId;
  if (!turnId) return undefined;

  try {
    const db = await getDb();
    await db.update(turns).set({ status: "complete" }).where(eq(turns.id, turnId));
  } catch (err) {
    tlog.error(`failed to complete turn ${turnId}`, log.errorData(err));
    // Don't clean up in-memory state on DB failure — allows retry
    return undefined;
  }

  if (activeTurns.get(k)?.turnId === turnId) activeTurns.delete(k);
  return turnId;
}

/**
 * Mark the turn a `done` closes as closing, synchronously on the `done`'s arrival: the turn
 * slot may be handed to the next delivery before its completion is recorded, and that
 * delivery's turn is its own. From here `deliveries` find this turn (`closedTurnFor`), so a
 * late report naming one is never taken by the next turn.
 */
export function markClosing(
  mind: string,
  session: string | null | undefined,
  turnId: string,
  deliveries: string[],
): void {
  const entry = activeTurns.get(key(mind, session));
  if (entry?.turnId === turnId) entry.closing = true;
  rememberClosed(mind, session, turnId, deliveries);
}

function rememberClosed(
  mind: string,
  session: string | null | undefined,
  turnId: string,
  deliveries: string[],
): void {
  let own = closedTurns.get(mind);
  if (!own) {
    own = new Map();
    closedTurns.set(mind, own);
  }
  for (const delivery of deliveries) own.set(closedKey(session, delivery), turnId);
  while (own.size > CLOSED_TURNS_PER_MIND) own.delete(own.keys().next().value!);
}

/** Mark orphaned active turns as complete and return their IDs for summary generation.
 *  Called on daemon startup to clean up turns from a previous daemon instance. */
export async function completeOrphanedTurns(): Promise<OrphanedTurn[]> {
  const db = await getDb();
  const active = await db
    .select({ id: turns.id, mind: turns.mind, session: turns.thread })
    .from(turns)
    .where(eq(turns.status, "active"));
  if (active.length === 0) return [];

  try {
    await db.update(turns).set({ status: "complete" }).where(eq(turns.status, "active"));
  } catch (err) {
    tlog.error("failed to complete orphaned turns on startup", log.errorData(err));
    // Still return the turns so callers can attempt summarization
  }

  tlog.info(`completed ${active.length} orphaned active turn(s) from previous daemon session`);
  return active.map((r) => ({
    turnId: r.id,
    mind: r.mind,
    session: r.session ?? undefined,
  }));
}

export type OrphanedTurn = { turnId: string; mind: string; session: string | undefined };

/** Remove all active turn entries for a mind (called on mind stop).
 *  Returns the orphaned turns so callers can generate summaries. */
export async function clearMind(mind: string): Promise<OrphanedTurn[]> {
  const toDelete: string[] = [];
  const orphaned: OrphanedTurn[] = [];
  for (const [k, entry] of activeTurns.entries()) {
    if (k.startsWith(`${mind}:`)) {
      const session = k.slice(mind.length + 1);
      orphaned.push({
        turnId: entry.turnId,
        mind,
        session: session === "*" ? undefined : session,
      });
      toDelete.push(k);
    }
  }
  for (const k of toDelete) activeTurns.delete(k);
  // Drop any errored-session flags and drained notice ids for this mind so a hard crash
  // can't leave one stale — keyed per delivery, they would otherwise outlive the process.
  for (const k of [...erroredSessions.keys()]) {
    if (k.startsWith(`${mind}:`)) erroredSessions.delete(k);
  }
  for (const k of [...drainedNotices.keys()]) {
    if (k.startsWith(`${mind}:`)) drainedNotices.delete(k);
  }
  closedTurns.delete(mind);
  forgetAwaitingUsage(mind);
  for (const k of [...interruptedRows.keys()]) {
    if (k.startsWith(`${mind}:`)) interruptedRows.delete(k);
  }
  // Mark orphaned turns as complete in DB
  if (orphaned.length > 0) {
    try {
      const db = await getDb();
      for (const { turnId } of orphaned) {
        await db.update(turns).set({ status: "complete" }).where(eq(turns.id, turnId));
      }
    } catch (err) {
      tlog.error(`failed to complete orphaned turns for ${mind}`, log.errorData(err));
    }
  }
  return orphaned;
}

/**
 * Reconcile turns wedged in `active` despite already having received a `done`, and
 * sessionless turns that have gone quiet.
 *
 * A turn with a session completes when a `done` that ends a turn arrives from the process
 * that opened it (see `handleMindEvent`). One that saw a `done` yet stayed active — its
 * completion failed to persist — would stay active indefinitely, never summarized,
 * absorbing later events.
 *
 * This sweep catches that: an active turn that has seen ≥1 `done` and has had no
 * events for `idleMs` is genuinely finished. A sessionless `mind:*` turn is closed only
 * by a sessionless `done` (a thread's `done` never ends an unrelated turn), and a
 * template that tags only its `done` never sends one — so a sessionless turn with no
 * events for `idleMs` is finished too, `done` or not. We mark it complete and drop any in-memory
 * entry so the next event opens a fresh turn. Callers summarize the returned turns and
 * forget the sessions' outstanding deliveries. Idempotent and safe to run on a timer.
 */
export async function sweepWedgedTurns(idleMs: number): Promise<OrphanedTurn[]> {
  const db = await getDb();
  // UTC "YYYY-MM-DD HH:MM:SS" to match how mind_history.created_at is stored.
  const cutoff = new Date(Date.now() - idleMs).toISOString().slice(0, 19).replace("T", " ");

  let rows: { id: string; mind: string; session: string | null }[];
  try {
    rows = await db
      .select({ id: turns.id, mind: turns.mind, session: turns.thread })
      .from(turns)
      .innerJoin(mindHistory, eq(mindHistory.turn_id, turns.id))
      .where(eq(turns.status, "active"))
      .groupBy(turns.id)
      .having(
        sql`max(${mindHistory.created_at}) < ${cutoff} and (${turns.thread} is null or sum(case when ${mindHistory.type} = 'done' then 1 else 0 end) > 0)`,
      );
  } catch (err) {
    tlog.error("failed to query wedged turns", log.errorData(err));
    return [];
  }

  const swept: OrphanedTurn[] = [];
  for (const r of rows) {
    try {
      await db.update(turns).set({ status: "complete" }).where(eq(turns.id, r.id));
    } catch (err) {
      tlog.error(`failed to complete wedged turn ${r.id}`, log.errorData(err));
      continue;
    }
    // Drop the matching in-memory entry so the next event opens a fresh turn instead
    // of re-tagging onto a now-complete one. Only delete the slot if it still points at
    // this turn — a newer turn may already have reused the session key.
    const k = key(r.mind, r.session);
    if (activeTurns.get(k)?.turnId === r.id) activeTurns.delete(k);
    swept.push({ turnId: r.id, mind: r.mind, session: r.session ?? undefined });
  }
  if (swept.length > 0) tlog.info(`swept ${swept.length} wedged turn(s)`);
  return swept;
}

/** Fire-and-forget summarization for a list of orphaned turns. */
export function summarizeOrphanedTurns(orphanedTurns: OrphanedTurn[]): void {
  for (const { turnId, mind, session } of orphanedTurns) {
    summarizeTurn(mind, session, undefined, 0, turnId).catch((err) =>
      tlog.warn(`failed to summarize orphaned turn ${turnId} for ${mind}`, log.errorData(err)),
    );
  }
}
