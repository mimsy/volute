import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db.js";
import log from "../logger.js";
import { turns } from "../schema.js";

const tlog = log.child("turn-tracker");

type ActiveTurn = {
  turnId: string;
  lastToolUseEventId: number | undefined;
};

/** In-memory map of active turns, keyed by `mind:session` (or `mind:*` for sessionless). */
const activeTurns = new Map<string, ActiveTurn>();

function key(mind: string, session?: string | null): string {
  return `${mind}:${session ?? "*"}`;
}

/**
 * Create a turn for a mind (or reuse an existing active one).
 * Initially sessionless — keyed as `mind:*`.
 */
export async function createTurn(mind: string): Promise<string> {
  const k = key(mind);
  const existing = activeTurns.get(k);
  if (existing) return existing.turnId;

  const turnId = randomUUID();
  try {
    const db = await getDb();
    await db.insert(turns).values({ id: turnId, mind, status: "active" });
  } catch (err) {
    tlog.error(`failed to create turn for ${mind}`, log.errorData(err));
  }

  activeTurns.set(k, { turnId, lastToolUseEventId: undefined });
  return turnId;
}

/** Get the active turn ID for a mind+session, falling back to the sessionless `mind:*` key. */
export function getActiveTurnId(mind: string, session?: string | null): string | undefined {
  return (activeTurns.get(key(mind, session)) ?? activeTurns.get(key(mind)))?.turnId;
}

/** Record the last tool_use event ID for a mind+session. */
export function trackToolUse(
  mind: string,
  session: string | null | undefined,
  eventId: number,
): void {
  const entry = activeTurns.get(key(mind, session)) ?? activeTurns.get(key(mind));
  if (entry) entry.lastToolUseEventId = eventId;
}

/** Get the last tool_use event ID for a mind+session. */
export function getLastToolUseEventId(mind: string, session?: string | null): number | undefined {
  return (activeTurns.get(key(mind, session)) ?? activeTurns.get(key(mind)))?.lastToolUseEventId;
}

/**
 * Assign a session to a sessionless turn.
 * Re-keys from `mind:*` to `mind:session` and updates the DB.
 */
export async function assignSession(mind: string, turnId: string, session: string): Promise<void> {
  const wildcardKey = key(mind);
  const entry = activeTurns.get(wildcardKey);
  if (!entry || entry.turnId !== turnId) return;

  activeTurns.delete(wildcardKey);
  activeTurns.set(key(mind, session), entry);

  try {
    const db = await getDb();
    await db.update(turns).set({ session }).where(eq(turns.id, turnId));
  } catch (err) {
    tlog.error(`failed to assign session to turn ${turnId}`, log.errorData(err));
  }
}

/** Mark a turn as complete. Returns the turnId (or undefined if none was active). */
export async function completeTurn(
  mind: string,
  session?: string | null,
): Promise<string | undefined> {
  const k = key(mind, session);
  const entry = activeTurns.get(k) ?? activeTurns.get(key(mind));
  if (!entry) return undefined;

  activeTurns.delete(k);
  activeTurns.delete(key(mind)); // clean up wildcard too

  try {
    const db = await getDb();
    await db.update(turns).set({ status: "complete" }).where(eq(turns.id, entry.turnId));
  } catch (err) {
    tlog.error(`failed to complete turn ${entry.turnId}`, log.errorData(err));
  }

  return entry.turnId;
}

/** Update a turn's summary_event_id. */
export async function setSummaryEventId(turnId: string, summaryEventId: number): Promise<void> {
  try {
    const db = await getDb();
    await db.update(turns).set({ summary_event_id: summaryEventId }).where(eq(turns.id, turnId));
  } catch (err) {
    tlog.error(`failed to set summary event for turn ${turnId}`, log.errorData(err));
  }
}

/** Remove all active turn entries for a mind (called on mind stop). */
export async function clearMind(mind: string): Promise<void> {
  const turnIds: string[] = [];
  for (const [k, entry] of activeTurns.entries()) {
    if (k.startsWith(`${mind}:`)) {
      turnIds.push(entry.turnId);
      activeTurns.delete(k);
    }
  }
  // Mark orphaned turns as complete in DB
  if (turnIds.length > 0) {
    try {
      const db = await getDb();
      for (const id of turnIds) {
        await db.update(turns).set({ status: "complete" }).where(eq(turns.id, id));
      }
    } catch (err) {
      tlog.error(`failed to complete orphaned turns for ${mind}`, log.errorData(err));
    }
  }
}
