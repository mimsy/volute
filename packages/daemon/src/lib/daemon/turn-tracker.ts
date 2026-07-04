import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
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
};

/** In-memory map of active turns, keyed by `mind:session` (or `mind:*` for sessionless). */
const activeTurns = new Map<string, ActiveTurn>();

function key(mind: string, session?: string | null): string {
  return `${mind}:${session ?? "*"}`;
}

/**
 * Sessions (`mind:session`) that have seen an `error` event since their last `done`.
 * Used to distinguish a failed turn from a clean one: failure notices are only marked
 * delivered after a turn that completed WITHOUT an error, so they accumulate across a
 * full outage and reach the mind on its next genuinely successful turn.
 */
const erroredSessions = new Set<string>();

/** Flag that the current turn for a mind+session hit an error. */
export function markErrored(mind: string, session?: string | null): void {
  erroredSessions.add(key(mind, session));
}

/** Return whether the just-finished turn errored, clearing the flag. */
export function takeErrored(mind: string, session?: string | null): boolean {
  return erroredSessions.delete(key(mind, session));
}

/**
 * Create a turn for a mind (or reuse an existing active one).
 * Initially sessionless — keyed as `mind:*`.
 *
 * The in-memory map entry is set BEFORE the DB insert to prevent a race where
 * two concurrent substantive events both pass the existence check. If the DB
 * insert fails, the entry is rolled back.
 */
export async function createTurn(mind: string): Promise<string | undefined> {
  const k = key(mind);
  const existing = activeTurns.get(k);
  if (existing) return existing.turnId;

  const turnId = randomUUID();
  const entry: ActiveTurn = {
    turnId,
    lastToolUseEventId: undefined,
    toolUseEventIds: new Map(),
  };
  // Reserve the slot synchronously to prevent concurrent callers from creating duplicates
  activeTurns.set(k, entry);

  try {
    const db = await getDb();
    await db.insert(turns).values({ id: turnId, mind, status: "active" });
  } catch (err) {
    tlog.error(`failed to create turn for ${mind}`, log.errorData(err));
    // Roll back the in-memory reservation
    if (activeTurns.get(k) === entry) activeTurns.delete(k);
    return undefined;
  }

  return turnId;
}

/** Get the active turn ID for a mind+session, falling back to the sessionless `mind:*` key. */
export function getActiveTurnId(mind: string, session?: string | null): string | undefined {
  return (activeTurns.get(key(mind, session)) ?? activeTurns.get(key(mind)))?.turnId;
}

/**
 * Attribute an inbound that arrives mid-turn to the turn already in progress.
 *
 * `TurnLifecycle.linkPendingInbound` only runs at turn CREATION and sweeps a bounded set of
 * the most-recent untagged inbounds. An inbound delivered while a turn is already active for
 * the session would otherwise wait for the NEXT same-channel turn to sweep it — and be left
 * `turn_id = NULL` forever if more than that bound accumulate or no later turn runs. Called
 * per-delivery: when the mind has an active turn for (mind, session), every still-untagged
 * inbound on that channel is attributed to it immediately.
 *
 * No-op when no turn is active yet — the turn-creation path (`linkPendingInbound`) tags the
 * triggering inbound then. Only `turn_id` is set here: the turn's `trigger_event_id` stays
 * the original triggering inbound, since a mid-turn message did not trigger the turn.
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
        eq(mindHistory.type, "inbound"),
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
  const entry = activeTurns.get(key(mind, session)) ?? activeTurns.get(key(mind));
  if (!entry) return;
  entry.lastToolUseEventId = eventId;
  if (toolUseId) entry.toolUseEventIds.set(toolUseId, eventId);
}

/** Get the last tool_use event ID for a mind+session. */
export function getLastToolUseEventId(mind: string, session?: string | null): number | undefined {
  return (activeTurns.get(key(mind, session)) ?? activeTurns.get(key(mind)))?.lastToolUseEventId;
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
  const entry = activeTurns.get(key(mind, session)) ?? activeTurns.get(key(mind));
  if (!entry) return undefined;
  if (toolUseId) {
    const id = entry.toolUseEventIds.get(toolUseId);
    if (id != null) return id;
  }
  return entry.lastToolUseEventId;
}

/**
 * Assign a session to a sessionless turn.
 * Re-keys from `mind:*` to `mind:session` and updates the DB.
 */
export async function assignSession(mind: string, turnId: string, session: string): Promise<void> {
  const wildcardKey = key(mind);
  const entry = activeTurns.get(wildcardKey);
  if (!entry || entry.turnId !== turnId) {
    tlog.warn(`assignSession: no matching turn for ${mind} (turnId=${turnId}, session=${session})`);
    return;
  }

  try {
    const db = await getDb();
    await db.update(turns).set({ session }).where(eq(turns.id, turnId));
  } catch (err) {
    tlog.error(`failed to assign session to turn ${turnId}`, log.errorData(err));
    return;
  }

  activeTurns.delete(wildcardKey);
  activeTurns.set(key(mind, session), entry);
}

/** Mark a turn as complete. Returns the turnId (or undefined if none was active). */
export async function completeTurn(
  mind: string,
  session?: string | null,
): Promise<string | undefined> {
  const k = key(mind, session);
  const wildcardKey = key(mind);
  const entry = activeTurns.get(k) ?? activeTurns.get(wildcardKey);
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
  activeTurns.delete(wildcardKey);

  return entry.turnId;
}

/** Mark orphaned active turns as complete and return their IDs for summary generation.
 *  Called on daemon startup to clean up turns from a previous daemon instance. */
export async function completeOrphanedTurns(): Promise<OrphanedTurn[]> {
  const db = await getDb();
  const active = await db
    .select({ id: turns.id, mind: turns.mind, session: turns.session })
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
 * Reconcile turns wedged in `active` despite already having received a `done`.
 *
 * A turn with a session completes only when a `done` arrives AND the delivery manager
 * reports the session as not busy (activeCount === 0). That counter increments per delivery
 * and decrements per `done` (or failed delivery); interrupts and maxWait flushes deliver
 * mid-turn yet get folded into fewer `done`s, so the counter can leak positive and gate
 * completion indefinitely (until the mind stops or this sweep runs) — the turn stays active,
 * never summarized, and keeps absorbing later events.
 *
 * This sweep catches that drift: an active turn that has seen ≥1 `done` and has had no
 * events for `idleMs` is genuinely finished. We mark it complete and drop any in-memory
 * entry so the next event opens a fresh turn. Callers summarize the returned turns and
 * reset the leaked session counter. Idempotent and safe to run on a timer.
 */
export async function sweepWedgedTurns(idleMs: number): Promise<OrphanedTurn[]> {
  const db = await getDb();
  // UTC "YYYY-MM-DD HH:MM:SS" to match how mind_history.created_at is stored.
  const cutoff = new Date(Date.now() - idleMs).toISOString().slice(0, 19).replace("T", " ");

  let rows: { id: string; mind: string; session: string | null }[];
  try {
    rows = await db
      .select({ id: turns.id, mind: turns.mind, session: turns.session })
      .from(turns)
      .innerJoin(mindHistory, eq(mindHistory.turn_id, turns.id))
      .where(eq(turns.status, "active"))
      .groupBy(turns.id)
      .having(
        sql`max(${mindHistory.created_at}) < ${cutoff} and sum(case when ${mindHistory.type} = 'done' then 1 else 0 end) > 0`,
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
