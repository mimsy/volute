import { and, asc, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { getDb } from "../db.js";
import { publish as publishMindEvent } from "../events/mind-events.js";
import { findMind, getBaseName } from "../mind/registry.js";
import { mindHistory, systemEvents, turns } from "../schema.js";
import log from "../util/logger.js";

const elog = log.child("system-events");

/**
 * Sentinel session for events not tied to a specific session (e.g. extension
 * notices). Drained into whichever session next runs a clean turn.
 */
export const MIND_LEVEL_SESSION = "";

export type EventDelivery = "immediate" | "next-turn";
export type WhileSleeping = "skip" | "queue" | "trigger-wake";

export type SystemEvent = typeof systemEvents.$inferSelect;

export type DeliverEventInput = {
  type: string;
  body: string;
  meta?: Record<string, unknown>;
  /** Routing session (default "main"). Next-turn notices may use MIND_LEVEL_SESSION. */
  session?: string;
  /** "immediate" POSTs an envelope to the mind (triggers a turn); "next-turn" waits. */
  delivery?: EventDelivery;
  /** How to handle an immediate event for a sleeping mind. */
  whileSleeping?: WhileSleeping;
  /** Bypass the sleeping check and POST directly (used by the wake path + queue flush). */
  force?: boolean;
};

/** Max undrained next-turn events retained per (mind, session) — bounds growth. */
const MAX_NEXT_TURN_EVENTS = 100;

/**
 * A worded label for an event, shown to the mind in the `[Event: <label> — <time>]`
 * envelope and to operators in the events UI. Never a raw id in isolation.
 */
export function eventLabel(type: string, meta: Record<string, unknown> | null | undefined): string {
  const m = meta ?? {};
  const s = (k: string): string | undefined =>
    typeof m[k] === "string" ? (m[k] as string) : undefined;
  switch (type) {
    case "schedule":
      return s("scheduleId") ? `Schedule: ${s("scheduleId")}` : "Schedule";
    case "sleep":
      return "Time to rest";
    case "wake":
      return "Woke from sleep";
    case "lifecycle":
      switch (s("subtype")) {
        case "merge":
          return "Variant merged in";
        case "split":
          return "Split into a variant";
        case "variant-created":
          return "Variant split off";
        case "sprout":
          return "Sprouted";
        case "upgrade":
          return "Framework upgraded";
        case "restart":
          return "Server restarted";
        case "farewell":
          return "Farewell before merge";
        case "sprout-welcome":
          return "A mind sprouted";
        default:
          return "Lifecycle";
      }
    case "orientation":
      return "Orientation";
    case "budget":
      return "Token budget";
    case "version":
      return "New version available";
    case "channel":
      return "Channel invite";
    case "file-share":
      return "File offered";
    case "webhook":
      return s("source") ? `Webhook: ${s("source")}` : "Webhook";
    case "notice":
      switch (s("subtype")) {
        case "crash":
          return "Crash notice";
        case "turn_error":
          return "Turn error";
        case "startup":
          return "Startup notice";
        case "extension":
          return s("reason") ? `Notice: ${s("reason")}` : "Notice";
        default:
          return "Notice";
      }
    default:
      return type.charAt(0).toUpperCase() + type.slice(1);
  }
}

/** The kinds of failure/informational notice that fold into next-turn events. */
export type NoticeKind = "turn_error" | "crash" | "budget" | "startup" | "extension";

export type RecordNoticeInput = {
  mind: string;
  session: string;
  kind: NoticeKind;
  reason: string;
  detail: string;
  raw?: string | null;
};

/**
 * Record a failure/informational notice as a `next-turn` event. A thin mapping over
 * {@link deliverEvent}: budget notices become `budget` events; everything else becomes a
 * `notice` event carrying the kind as `meta.subtype` and the reason in `meta.reason`.
 */
export async function recordNotice(input: RecordNoticeInput): Promise<void> {
  const type = input.kind === "budget" ? "budget" : "notice";
  await deliverEvent(input.mind, {
    type,
    body: input.detail,
    session: input.session,
    delivery: "next-turn",
    meta: {
      subtype: input.kind,
      reason: input.reason,
      ...(input.raw ? { raw: input.raw } : {}),
    },
  });
}

/** Record an event's arrival in mind_history so `mind history` and the activity feed work. */
async function recordEventInbound(
  mind: string,
  type: string,
  body: string,
  eventId: number,
): Promise<void> {
  try {
    const db = await getDb();
    await db.insert(mindHistory).values({
      mind,
      type: "inbound",
      channel: `event:${type}`,
      sender: null,
      content: body,
      metadata: JSON.stringify({ systemEventId: eventId }),
    });
  } catch (err) {
    elog.warn(`failed to persist event inbound for ${mind}`, log.errorData(err));
  }
  publishMindEvent(mind, { mind, type: "inbound", channel: `event:${type}`, content: body });
}

/** POST an event envelope to a running mind's /message endpoint. Returns whether it acked. */
async function postEventEnvelope(mind: string, event: SystemEvent): Promise<boolean> {
  const baseName = await getBaseName(mind);
  const entry = await findMind(baseName);
  if (!entry) {
    elog.warn(`cannot deliver event to ${mind}: mind not found`);
    return false;
  }
  const meta = event.meta ? (JSON.parse(event.meta) as Record<string, unknown>) : undefined;
  try {
    const res = await fetch(`http://127.0.0.1:${entry.port}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "event",
        event: {
          id: event.id,
          type: event.type,
          label: eventLabel(event.type, meta),
          body: event.body,
          at: event.created_at,
        },
        session: event.session,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch (err) {
    elog.warn(`failed to POST event ${event.id} to ${mind}`, log.errorData(err));
    return false;
  }
}

/** Stamp an event's delivered_at (and optionally merge extra meta). */
async function markDelivered(id: number, extraMeta?: Record<string, unknown>): Promise<void> {
  const db = await getDb();
  if (extraMeta) {
    const row = await db
      .select({ meta: systemEvents.meta })
      .from(systemEvents)
      .where(eq(systemEvents.id, id))
      .get();
    const merged = { ...(row?.meta ? JSON.parse(row.meta) : {}), ...extraMeta };
    await db
      .update(systemEvents)
      .set({ delivered_at: sql`(datetime('now'))`, meta: JSON.stringify(merged) })
      .where(eq(systemEvents.id, id));
  } else {
    await db
      .update(systemEvents)
      .set({ delivered_at: sql`(datetime('now'))` })
      .where(eq(systemEvents.id, id));
  }
}

/**
 * Deliver a system event to a mind. Inserts the row, then:
 * - `immediate` + awake (or `force`): POSTs the envelope and stamps `delivered_at`.
 * - `immediate` + sleeping: applies `whileSleeping` (`queue` leaves it pending to flush on
 *   wake; `skip` stamps it delivered with `meta.skipped`; `trigger-wake` queues + wakes).
 * - `next-turn`: leaves it pending to be drained as a context block on the mind's next turn.
 *
 * Never throws — logs and returns the event id plus whether it was POSTed to the mind now.
 */
export async function deliverEvent(
  mind: string,
  input: DeliverEventInput,
): Promise<{ id?: number; delivered: boolean }> {
  const session = input.session ?? "main";
  const delivery = input.delivery ?? "immediate";
  let eventId: number | undefined;
  try {
    const db = await getDb();
    const rows = await db
      .insert(systemEvents)
      .values({
        mind,
        type: input.type,
        body: input.body,
        meta: input.meta ? JSON.stringify(input.meta) : null,
        delivery,
        session,
      })
      .returning({ id: systemEvents.id });
    eventId = rows[0]?.id;
    if (eventId == null) return { delivered: false };

    // Bound next-turn growth per (mind, session).
    if (delivery === "next-turn") {
      await db.run(
        sql`DELETE FROM system_events WHERE mind = ${mind} AND session = ${session} AND delivery = 'next-turn' AND delivered_at IS NULL AND id NOT IN (SELECT id FROM system_events WHERE mind = ${mind} AND session = ${session} AND delivery = 'next-turn' AND delivered_at IS NULL ORDER BY id DESC LIMIT ${MAX_NEXT_TURN_EVENTS})`,
      );
      return { id: eventId, delivered: false };
    }

    // Immediate delivery.
    const baseName = await getBaseName(mind);
    const { getSleepManagerIfReady } = await import("../daemon/sleep-manager.js");
    const sleepManager = getSleepManagerIfReady();
    const sleeping = !input.force && sleepManager?.isSleeping(baseName);

    // Sleeping + skip: the mind never sees it — don't record inbound history.
    const behavior = input.whileSleeping ?? "queue";
    if (sleeping && behavior === "skip") {
      await markDelivered(eventId, { skipped: true });
      return { id: eventId, delivered: false };
    }

    // Record the arrival in mind_history (as recordInbound does for messages), so an event
    // shows in history even if the mind isn't up to accept the turn right now.
    await recordEventInbound(mind, input.type, input.body, eventId);

    if (!sleeping) {
      const event = await db.select().from(systemEvents).where(eq(systemEvents.id, eventId)).get();
      if (event && (await postEventEnvelope(mind, event))) {
        await markDelivered(eventId);
        markPendingReflection(mind, session, eventId);
        return { id: eventId, delivered: true };
      }
      return { id: eventId, delivered: false };
    }

    // Sleeping: "queue" and "trigger-wake" both leave the row pending to flush on wake.
    if (behavior === "trigger-wake") {
      sleepManager
        ?.initiateWake(baseName, { trigger: { channel: `event:${input.type}` } })
        .catch((err) =>
          elog.warn(`failed to trigger-wake ${baseName} for event`, log.errorData(err)),
        );
    }
    return { id: eventId, delivered: false };
  } catch (err) {
    elog.warn(`failed to deliver event to ${mind}`, log.errorData(err));
    return { id: eventId, delivered: false };
  }
}

/**
 * Deliver pending immediate events (oldest-first) to a now-awake mind. Called by the
 * sleep manager after the wake event on both full and trigger wakes.
 */
export async function flushQueuedEvents(mind: string): Promise<number> {
  try {
    const db = await getDb();
    const rows = await db
      .select()
      .from(systemEvents)
      .where(
        and(
          eq(systemEvents.mind, mind),
          eq(systemEvents.delivery, "immediate"),
          isNull(systemEvents.delivered_at),
        ),
      )
      .orderBy(asc(systemEvents.id))
      .all();
    let delivered = 0;
    for (const event of rows) {
      // Inbound history was already recorded at arrival (deliverEvent); just deliver now.
      if (await postEventEnvelope(mind, event)) {
        await markDelivered(event.id);
        markPendingReflection(mind, event.session, event.id);
        delivered++;
      }
    }
    return delivered;
  } catch (err) {
    elog.warn(`failed to flush queued events for ${mind}`, log.errorData(err));
    return 0;
  }
}

/** Count pending immediate events (queued while sleeping) for a mind. */
export async function pendingEventCount(mind: string): Promise<number> {
  try {
    const db = await getDb();
    const row = await db
      .select({ n: sql<number>`count(*)` })
      .from(systemEvents)
      .where(
        and(
          eq(systemEvents.mind, mind),
          eq(systemEvents.delivery, "immediate"),
          isNull(systemEvents.delivered_at),
        ),
      )
      .get();
    return row?.n ?? 0;
  } catch (err) {
    elog.warn(`failed to count pending events for ${mind}`, log.errorData(err));
    return 0;
  }
}

// --- Next-turn drain (port of the notices context-block path) ---

/**
 * Undrained next-turn events for a mind+session, oldest first. Includes mind-level
 * events (session = "") so they reach whichever session next runs a turn.
 */
export async function drainEvents(
  mind: string,
  session: string,
  limit = MAX_NEXT_TURN_EVENTS,
): Promise<SystemEvent[]> {
  const db = await getDb();
  return db
    .select()
    .from(systemEvents)
    .where(
      and(
        eq(systemEvents.mind, mind),
        eq(systemEvents.delivery, "next-turn"),
        isNull(systemEvents.delivered_at),
        or(eq(systemEvents.session, session), eq(systemEvents.session, MIND_LEVEL_SESSION)),
      ),
    )
    .orderBy(asc(systemEvents.id))
    .limit(limit);
}

function metaOf(e: SystemEvent): Record<string, unknown> {
  return e.meta ? (JSON.parse(e.meta) as Record<string, unknown>) : {};
}

const FAILURE_SUBTYPES = new Set(["turn_error", "crash", "startup"]);
const NOTICE_HEADER =
  "[Notices] While you were unavailable, one or more turns failed. You're back now:";

/**
 * Render next-turn events as a context block. Failure notices group identical reasons into
 * one line with a count and time span; budget and version events get their own blocks;
 * extension notices render one line each under a per-extension header. Returns null if empty.
 */
export function formatEvents(events: SystemEvent[]): string | null {
  if (events.length === 0) return null;

  const failures = events.filter(
    (e) => e.type === "notice" && FAILURE_SUBTYPES.has(String(metaOf(e).subtype)),
  );
  const budgets = events.filter((e) => e.type === "budget");
  const versions = events.filter((e) => e.type === "version");
  const extensions = events.filter((e) => e.type === "notice" && metaOf(e).subtype === "extension");

  const blocks: string[] = [];

  if (failures.length > 0) {
    const groups = new Map<
      string,
      { count: number; detail: string; first: string; last: string }
    >();
    for (const e of failures) {
      const reason = String(metaOf(e).reason ?? "unknown");
      const time = localHM(e.created_at);
      const g = groups.get(reason);
      if (g) {
        g.count += 1;
        g.detail = e.body;
        g.last = time;
      } else {
        groups.set(reason, { count: 1, detail: e.body, first: time, last: time });
      }
    }
    const lines = [...groups.values()].map((g) => {
      const span = g.first === g.last ? g.first : `${g.first}–${g.last}`;
      const plural = g.count === 1 ? "turn" : "turns";
      return `- ${g.count} ${plural} failed (${span}): ${g.detail}`;
    });
    blocks.push(`${NOTICE_HEADER}\n${lines.join("\n")}`);
  }

  if (budgets.length > 0) {
    const lines = budgets.map((e) => `- ${localHM(e.created_at)} ${e.body}`);
    blocks.push(`[Budget]\n${lines.join("\n")}`);
  }

  if (versions.length > 0) {
    const lines = versions.map((e) => `- ${localHM(e.created_at)} ${e.body}`);
    blocks.push(`[Update]\n${lines.join("\n")}`);
  }

  if (extensions.length > 0) {
    const byExt = new Map<string, SystemEvent[]>();
    for (const e of extensions) {
      const ext = String(metaOf(e).reason ?? "extension");
      const arr = byExt.get(ext);
      if (arr) arr.push(e);
      else byExt.set(ext, [e]);
    }
    for (const [ext, items] of byExt) {
      const header = `[${ext.charAt(0).toUpperCase()}${ext.slice(1)}]`;
      const lines = items.map((e) => `- ${localHM(e.created_at)} ${e.body}`);
      blocks.push(`${header}\n${lines.join("\n")}`);
    }
  }

  return blocks.join("\n\n");
}

function localHM(createdAt: string): string {
  const iso = createdAt.endsWith("Z") ? createdAt : `${createdAt.replace(" ", "T")}Z`;
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Mark next-turn events delivered for a mind+session up to and including `uptoId`. Unlike
 * the old notices table (which deleted rows), events persist — we stamp `delivered_at` so
 * they stay visible in the events history/UI.
 */
export async function clearDeliveredEvents(
  mind: string,
  session: string,
  uptoId: number,
): Promise<void> {
  try {
    const db = await getDb();
    await db
      .update(systemEvents)
      .set({ delivered_at: sql`(datetime('now'))` })
      .where(
        and(
          eq(systemEvents.mind, mind),
          eq(systemEvents.delivery, "next-turn"),
          isNull(systemEvents.delivered_at),
          or(eq(systemEvents.session, session), eq(systemEvents.session, MIND_LEVEL_SESSION)),
          lte(systemEvents.id, uptoId),
        ),
      );
  } catch (err) {
    elog.warn(`failed to clear delivered events for ${mind}:${session}`, log.errorData(err));
  }
}

// --- Status surfaces (ports of latestFailureNotice / latestNotice / hasUndeliveredNotice) ---

export type FailureNotice = { kind: string; reason: string; detail: string; at: string };

let failureReadErrorLogged = false;

/**
 * The most recent undelivered failure notice event for a mind with no completed turn since
 * (across all sessions). Used by chat to surface "last turn failed" (#574). Null on error.
 */
export async function latestFailureEvent(mind: string): Promise<FailureNotice | null> {
  try {
    const db = await getDb();
    const rows = await db
      .select()
      .from(systemEvents)
      .where(
        and(
          eq(systemEvents.mind, mind),
          eq(systemEvents.type, "notice"),
          isNull(systemEvents.delivered_at),
        ),
      )
      .orderBy(desc(systemEvents.id))
      .all();
    const e = rows.find((r) => FAILURE_SUBTYPES.has(String(metaOf(r).subtype)));
    if (!e) return null;

    const recovered = await db
      .select({ id: turns.id })
      .from(turns)
      .where(
        and(eq(turns.mind, mind), eq(turns.status, "complete"), gt(turns.created_at, e.created_at)),
      )
      .limit(1);
    if (recovered.length > 0) return null;

    const m = metaOf(e);
    return {
      kind: String(m.subtype ?? "notice"),
      reason: String(m.reason ?? "unknown"),
      detail: e.body,
      at: e.created_at,
    };
  } catch (err) {
    if (!failureReadErrorLogged) {
      failureReadErrorLogged = true;
      elog.error(`failed to read latest failure event for ${mind}`, log.errorData(err));
    }
    return null;
  }
}

/** The most recent undelivered next-turn event for a mind. Used by `mind status`. */
export async function latestEvent(
  mind: string,
): Promise<{ kind: string; reason: string; detail: string; created_at: string } | null> {
  const db = await getDb();
  const row = await db
    .select()
    .from(systemEvents)
    .where(
      and(
        eq(systemEvents.mind, mind),
        eq(systemEvents.delivery, "next-turn"),
        isNull(systemEvents.delivered_at),
      ),
    )
    .orderBy(desc(systemEvents.id))
    .limit(1)
    .get();
  if (!row) return null;
  const m = metaOf(row);
  return {
    kind: String(m.subtype ?? row.type),
    reason: String(m.reason ?? row.type),
    detail: row.body,
    created_at: row.created_at,
  };
}

/** True if the mind has an undelivered next-turn event with this meta.reason (any session). */
export async function hasUndeliveredEvent(mind: string, reason: string): Promise<boolean> {
  const db = await getDb();
  const row = await db
    .select({ id: systemEvents.id })
    .from(systemEvents)
    .where(
      and(
        eq(systemEvents.mind, mind),
        eq(systemEvents.delivery, "next-turn"),
        isNull(systemEvents.delivered_at),
        sql`json_extract(${systemEvents.meta}, '$.reason') = ${reason}`,
      ),
    )
    .limit(1)
    .get();
  return row != null;
}

/** List events for a mind, newest first (for the events API/UI). */
export async function listEvents(
  mind: string,
  limit = 100,
  before?: number,
): Promise<SystemEvent[]> {
  const db = await getDb();
  const conditions = [eq(systemEvents.mind, mind)];
  if (before != null) conditions.push(sql`${systemEvents.id} < ${before}`);
  return db
    .select()
    .from(systemEvents)
    .where(and(...conditions))
    .orderBy(desc(systemEvents.id))
    .limit(limit);
}

// --- Reflection capture ---

/**
 * eventId awaiting a reflection, keyed by `mind:session`. Set when an immediate event is
 * delivered; consumed when the next turn on that session completes. In-memory and
 * best-effort — a daemon restart between delivery and turn-done drops the reflection.
 */
const pendingReflections = new Map<string, number>();

function markPendingReflection(mind: string, session: string, eventId: number): void {
  pendingReflections.set(`${mind}:${session}`, eventId);
}

/** Store `text` as the reflection on an event row. */
export async function recordReflection(eventId: number, text: string): Promise<void> {
  try {
    const db = await getDb();
    await db.update(systemEvents).set({ reflection: text }).where(eq(systemEvents.id, eventId));
  } catch (err) {
    elog.warn(`failed to record reflection for event ${eventId}`, log.errorData(err));
  }
}

/**
 * If an immediate event was delivered to this mind+session, attribute the completed turn's
 * final text to it as a reflection. Called from turn-lifecycle when a turn completes.
 */
export async function captureReflection(
  mind: string,
  session: string | null | undefined,
  turnId: string | null | undefined,
): Promise<void> {
  if (!session || !turnId) return;
  const key = `${mind}:${session}`;
  const eventId = pendingReflections.get(key);
  if (eventId == null) return;
  pendingReflections.delete(key);
  try {
    const db = await getDb();
    const row = await db
      .select({ content: mindHistory.content })
      .from(mindHistory)
      .where(
        and(
          eq(mindHistory.mind, mind),
          eq(mindHistory.turn_id, turnId),
          eq(mindHistory.type, "text"),
        ),
      )
      .orderBy(desc(mindHistory.id))
      .limit(1)
      .get();
    const text = row?.content?.trim();
    if (text) await recordReflection(eventId, text);
  } catch (err) {
    elog.warn(`failed to capture reflection for ${key}`, log.errorData(err));
  }
}

/** Reset in-memory reflection state (for tests). */
export function _resetReflectionState(): void {
  pendingReflections.clear();
}
