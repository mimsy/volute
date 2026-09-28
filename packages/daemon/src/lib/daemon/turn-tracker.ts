import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../db.js";
import { mindHistory, turns } from "../schema.js";
import log from "../util/logger.js";
import { summarizeTurn } from "./summarizer.js";

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
   * The delivery that drove the turn — the `messageId` on the event that opened it. A `done`
   * ends this turn only if it names the same one (see `handleMindEvent`), so a `done` that
   * belongs to some other delivery cannot close a turn still running (#1207).
   */
  driver: string | undefined;
};

/**
 * In-memory map of active turns, keyed by `mind:thread` (or `mind:*` for events that carry
 * no thread). Every lookup is exact: a thread never resolves to another key's turn. A
 * fallback from a thread to the sessionless slot once credited one thread's send to a
 * sibling thread's turn (#1173).
 */
const activeTurns = new Map<string, ActiveTurn>();

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
 * Turns (`mind:session:messageId`) that have seen an `error` event since their `done`.
 * Used to distinguish a failed turn from a clean one: failure notices are only marked
 * delivered after a turn that completed WITHOUT an error, so they accumulate across a
 * full outage and reach the mind on its next genuinely successful turn. Keyed by the
 * delivery the error names, so an error in one turn is never charged to another on the
 * same session; an error naming none is keyed by the session alone.
 */
const erroredSessions = new Set<string>();

function errKey(mind: string, session: string | null | undefined, messageId?: string): string {
  // NUL, not ":", between the parts: thread names are channel-shaped and carry colons.
  return `${key(mind, session)}\0${messageId ?? ""}`;
}

/** Flag that the turn driven by `messageId` (or, naming none, the session's) hit an error. */
export function markErrored(mind: string, session?: string | null, messageId?: string): void {
  erroredSessions.add(errKey(mind, session, messageId));
}

/**
 * Return whether any of the turns driven by `messageIds` errored, clearing every flag read.
 * The session's unkeyed flag (an error that named no turn) is read too unless `unkeyed` is
 * false; without `messageIds`, every flag on the session is.
 */
export function takeErrored(
  mind: string,
  session?: string | null,
  messageIds?: string[],
  unkeyed = true,
): boolean {
  let errored = false;
  if (!messageIds) {
    const prefix = `${key(mind, session)}\0`;
    for (const k of [...erroredSessions]) {
      if (k.startsWith(prefix)) errored = erroredSessions.delete(k) || errored;
    }
    return errored;
  }
  if (unkeyed) errored = erroredSessions.delete(errKey(mind, session));
  for (const id of messageIds)
    errored = erroredSessions.delete(errKey(mind, session, id)) || errored;
  return errored;
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
  driver?: string,
): Promise<string | undefined> {
  const k = key(mind, session);
  const existing = activeTurns.get(k);
  if (existing) return existing.turnId;

  const turnId = randomUUID();
  const entry: ActiveTurn = {
    turnId,
    lastToolUseEventId: undefined,
    toolUseEventIds: new Map(),
    owner,
    driver,
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
  return activeTurns.get(key(mind, session))?.owner;
}

/** The delivery that drove this mind+thread's active turn (see `ActiveTurn.driver`). */
export function getActiveTurnDriver(mind: string, session?: string | null): string | undefined {
  return activeTurns.get(key(mind, session))?.driver;
}

/** Get the active turn ID for exactly this mind+thread (`mind:*` when there is none). */
export function getActiveTurnId(mind: string, session?: string | null): string | undefined {
  return activeTurns.get(key(mind, session))?.turnId;
}

/**
 * Attribute an inbound message OR a system event that arrives mid-turn to the turn already in
 * progress.
 *
 * `TurnLifecycle.linkPendingInbound` only runs at turn CREATION and sweeps a bounded set of
 * the most-recent untagged rows. One delivered while a turn is already active for the session
 * would otherwise wait for the NEXT same-channel turn to sweep it — and be left
 * `turn_id = NULL` forever if more than that bound accumulate or no later turn runs. Called
 * per-delivery: when the mind has an active turn for (mind, session), every still-untagged
 * row on that channel is attributed to it immediately.
 *
 * The type filter below must match "event" as well as "inbound". Events are POSTed with no
 * busy check, so one can land while a turn is running, and this is the only path that
 * attributes it. Narrow the filter and the event silently drops out of the turn's `events`
 * array in the timeline and out of the summarizer's transcript — no error, no log; as far as
 * history is concerned it never arrived. Guarded by "tags a system event arriving mid-turn"
 * in test/turn-lifecycle.test.ts.
 *
 * No-op when no turn is active yet — the turn-creation path (`linkPendingInbound`) tags the
 * trigger then. Only `turn_id` is set here: the turn's `trigger_event_id` stays the original
 * trigger, since a mid-turn arrival did not trigger the turn.
 */
export async function linkInboundToActiveTurn(
  mind: string,
  session: string | null | undefined,
  channel?: string,
): Promise<void> {
  // Channel is required to prevent cross-session tagging (mirrors linkPendingInbound).
  if (!channel) return;
  const turnId = getActiveTurnId(mind, session);
  if (!turnId) return;
  const db = await getDb();
  await db
    .update(mindHistory)
    .set({ turn_id: turnId })
    .where(
      and(
        eq(mindHistory.mind, mind),
        // System events ("event") arrive mid-turn too and need the same attribution.
        inArray(mindHistory.type, ["inbound", "event"]),
        sql`${mindHistory.turn_id} IS NULL`,
        eq(mindHistory.channel, channel),
      ),
    );
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
): Promise<string | undefined> {
  const k = key(mind, session);
  const entry = activeTurns.get(k);
  if (!entry) return undefined;

  try {
    const db = await getDb();
    await db.update(turns).set({ status: "complete" }).where(eq(turns.id, entry.turnId));
  } catch (err) {
    tlog.error(`failed to complete turn ${entry.turnId}`, log.errorData(err));
    // Don't clean up in-memory state on DB failure — allows retry
    return undefined;
  }

  activeTurns.delete(k);

  return entry.turnId;
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
  // Drop any errored-session flags for this mind so a hard crash can't leave one stale.
  for (const k of [...erroredSessions]) {
    if (k.startsWith(`${mind}:`)) erroredSessions.delete(k);
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
 * A turn with a session completes when a `done` naming its driver arrives from the process
 * that opened it (see `handleMindEvent`). One that saw a `done` yet stayed active — its
 * completion failed to persist, or a `done` named some other delivery and the turn's own
 * never came — would stay active indefinitely, never summarized, absorbing later events.
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
