import { and, asc, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { getDb } from "../db.js";
import { publish as publishMindEvent } from "../events/mind-events.js";
import { findMind, getBaseName } from "../mind/registry.js";
import { mindHistory, systemEvents, turns } from "../schema.js";
import log from "../util/logger.js";
import { newEphemeralSession } from "../util/session-name.js";

const elog = log.child("system-events");

/**
 * Sentinel thread for events not tied to a specific thread (e.g. extension
 * notices). Drained into whichever thread next runs a clean turn.
 */
export const MIND_LEVEL_THREAD = "";

export type EventDelivery = "immediate" | "next-turn";
export type WhileSleeping = "skip" | "queue" | "trigger-wake";

export type SystemEvent = typeof systemEvents.$inferSelect;

export type DeliverEventInput = {
  type: string;
  body: string;
  meta?: Record<string, unknown>;
  /** Routing thread (default "main"). Next-turn notices may use MIND_LEVEL_THREAD. */
  thread?: string;
  /** "immediate" POSTs an envelope to the mind (triggers a turn); "next-turn" waits. */
  delivery?: EventDelivery;
  /** How to handle an immediate event for a sleeping mind. */
  whileSleeping?: WhileSleeping;
  /** Bypass the sleeping check and POST directly (used by the wake path + queue flush). */
  force?: boolean;
};

/** Max undrained next-turn events retained per (mind, thread) — bounds growth. */
const MAX_NEXT_TURN_EVENTS = 100;

/** Pending immediate events older than this are expired at flush, not replayed stale. */
const FLUSH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Parse an event row's meta JSON, tolerating corrupt rows: a single bad row must
 * degrade to `{}` (with an error log) rather than throwing into a flush loop or an
 * API handler and wedging everything behind it.
 */
export function parseMeta(
  meta: string | null | undefined,
  context?: string,
): Record<string, unknown> {
  if (!meta) return {};
  try {
    return JSON.parse(meta) as Record<string, unknown>;
  } catch (err) {
    elog.error(`corrupt event meta${context ? ` (${context})` : ""}: ${meta}`, log.errorData(err));
    return {};
  }
}

/**
 * A worded label for an event, shown to the mind in the `=== System event: <label> — <time> ===`
 * envelope and to hosts in the events UI and timeline. Never a raw id in isolation.
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
        case "delivery_failed":
          return "Delivery failed";
        case "join_blocked":
          return "Variant join blocked";
        default:
          return "Notice";
      }
    default:
      return type.charAt(0).toUpperCase() + type.slice(1);
  }
}

/** The kinds of failure/informational notice that fold into next-turn events. */
export type NoticeKind =
  | "turn_error"
  | "crash"
  | "budget"
  | "startup"
  | "extension"
  | "delivery_failed"
  | "join_blocked";

export type RecordNoticeInput = {
  mind: string;
  thread: string;
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
    thread: input.thread,
    delivery: "next-turn",
    meta: {
      subtype: input.kind,
      reason: input.reason,
      ...(input.raw ? { raw: input.raw } : {}),
    },
  });
}

/**
 * The channel slug an event's turn is attributed under. Unique per event so
 * `linkPendingInbound` links each event turn to exactly its own event row (which
 * carries `meta.systemEventId`), giving exact reflection attribution. The template
 * builds the same slug from the envelope's type + id when dispatching.
 */
export function eventChannel(type: string, id: number): string {
  return `event:${type}:${id}`;
}

/**
 * Record an event's actual delivery in mind_history so `mind history` and the activity
 * feed keep working. Called only after a successful POST — an event the mind never
 * received must not claim it was heard (#420). Recorded under the base name, matching
 * how the delivery pipeline records incoming messages.
 *
 * The row type is `event`, not `inbound`: an event is not a message, and the surfaces that
 * render history (web timeline, `volute mind history`) key off this type to show it as a
 * system marker instead of a chat bubble with a phantom sender. The label rides along in
 * the row metadata so those surfaces don't have to re-derive it from `system_events`.
 */
async function recordEventRow(mind: string, event: SystemEvent): Promise<void> {
  const channel = eventChannel(event.type, event.id);
  const label = eventLabel(event.type, parseMeta(event.meta, `event ${event.id}`));
  const metadata = { systemEventId: event.id, label };
  try {
    const db = await getDb();
    const baseName = await getBaseName(mind);
    await db.insert(mindHistory).values({
      mind: baseName,
      type: "event",
      channel,
      sender: null,
      content: event.body,
      metadata: JSON.stringify(metadata),
    });
    publishMindEvent(baseName, {
      mind: baseName,
      type: "event",
      channel,
      content: event.body,
      metadata,
    });
  } catch (err) {
    elog.warn(`failed to persist event row for ${mind}`, log.errorData(err));
  }
}

/** Minds already warned about a template that predates system events (once per lifetime). */
const staleTemplateWarned = new Set<string>();

/**
 * POST an event envelope to a running mind's /message endpoint. Resolves the target's
 * OWN registry row — a variant has its own port, and misresolving to the parent would
 * deliver its farewell/split context to the wrong process. Returns whether it acked.
 */
async function postEventEnvelope(mind: string, event: SystemEvent): Promise<boolean> {
  const entry = await findMind(mind);
  if (!entry) {
    elog.warn(`cannot deliver event ${event.id} to ${mind}: mind not found`);
    return false;
  }
  const meta = parseMeta(event.meta, `event ${event.id}`);
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
        session: event.thread,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      elog.warn(`mind ${mind} rejected event ${event.id}: HTTP ${res.status}`);
      return false;
    }
    // A template that understands events acks with { event: true }. A pre-events
    // template 200-acks after mangling the envelope into a garbage message — still
    // counted delivered (hard cut, no compat path), but surfaced loudly once so the
    // host knows the mind needs `volute mind upgrade`.
    try {
      const ack = (await res.json()) as { event?: boolean };
      if (ack.event !== true && !staleTemplateWarned.has(mind)) {
        staleTemplateWarned.add(mind);
        elog.warn(
          `mind ${mind} ack'd an event without event support — its template predates ` +
            `system events; run \`volute mind upgrade ${mind}\``,
        );
      }
    } catch {
      // Unparseable ack body — treat like a stale template ack, but don't fail delivery.
      if (!staleTemplateWarned.has(mind)) {
        staleTemplateWarned.add(mind);
        elog.warn(
          `mind ${mind} ack'd an event without event support — its template predates ` +
            `system events; run \`volute mind upgrade ${mind}\``,
        );
      }
    }
    return true;
  } catch (err) {
    elog.warn(`failed to POST event ${event.id} to ${mind}`, log.errorData(err));
    return false;
  }
}

/**
 * Stamp an event's delivered_at (and optionally merge extra meta). Never throws — a
 * failure here after a successful POST means the event will be redelivered on the next
 * wake/start, so it's surfaced at error level rather than silently causing a replay.
 */
async function markDelivered(id: number, extraMeta?: Record<string, unknown>): Promise<void> {
  try {
    const db = await getDb();
    if (extraMeta) {
      const row = await db
        .select({ meta: systemEvents.meta })
        .from(systemEvents)
        .where(eq(systemEvents.id, id))
        .get();
      const merged = { ...parseMeta(row?.meta, `event ${id}`), ...extraMeta };
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
  } catch (err) {
    elog.error(
      `failed to stamp event ${id} delivered — it will be redelivered on the next wake/start`,
      log.errorData(err),
    );
  }
}

/**
 * Resolve an event's stored thread, expanding the `$new` convention ("a fresh isolated
 * session per fire") the same way the message path does. Expansion lives here so every
 * caller passing `$new` — scheduler, default dream autonomy, future — gets isolation without
 * owning the contract itself (#735).
 *
 * `$new` only means something for `immediate` delivery, which POSTs an envelope and runs a
 * turn in the fresh session. A `next-turn` event stamped to a unique session that never runs
 * a turn would strand forever (#356/#721), so it collapses to the mind-level sentinel and
 * drains into whichever thread next runs a clean turn. Uses the shared session-name minter so
 * the name shape is identical to the message path's mind-side.
 */
function resolveEventThread(thread: string, delivery: EventDelivery): string {
  if (thread !== "$new") return thread;
  return delivery === "immediate" ? newEphemeralSession() : MIND_LEVEL_THREAD;
}

/**
 * Deliver a system event to a mind. Inserts the row, then:
 * - `immediate` + awake (or `force`): POSTs the envelope; on success stamps
 *   `delivered_at` and records the event row in mind_history. A failed POST leaves the
 *   row pending — it is redelivered on the next wake or mind start.
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
  const delivery = input.delivery ?? "immediate";
  const thread = resolveEventThread(input.thread ?? "main", delivery);
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
        thread,
      })
      .returning({ id: systemEvents.id });
    eventId = rows[0]?.id;
    if (eventId == null) {
      elog.error(`event insert for ${mind} (${input.type}) returned no id — event dropped`);
      return { delivered: false };
    }

    // Bound next-turn growth per (mind, thread): stamp overflow rows dropped (they stay
    // visible in the events UI) rather than deleting them.
    if (delivery === "next-turn") {
      await db.run(
        sql`UPDATE system_events SET delivered_at = datetime('now'), meta = json_set(COALESCE(meta, '{}'), '$.dropped', 1) WHERE mind = ${mind} AND thread = ${thread} AND delivery = 'next-turn' AND delivered_at IS NULL AND id NOT IN (SELECT id FROM system_events WHERE mind = ${mind} AND thread = ${thread} AND delivery = 'next-turn' AND delivered_at IS NULL ORDER BY id DESC LIMIT ${MAX_NEXT_TURN_EVENTS})`,
      );
      return { id: eventId, delivered: false };
    }

    // Immediate delivery. Sleep state is tracked under the base name (variants don't
    // sleep independently); the delivery target below keeps the mind's own name/port.
    const baseName = await getBaseName(mind);
    const { getSleepManagerIfReady } = await import("../daemon/sleep-manager.js");
    const sleepManager = getSleepManagerIfReady();
    const sleeping = !input.force && sleepManager?.isSleeping(baseName);

    // Sleeping + skip: the mind never sees it.
    const behavior = input.whileSleeping ?? "queue";
    if (sleeping && behavior === "skip") {
      await markDelivered(eventId, { skipped: true });
      return { id: eventId, delivered: false };
    }

    if (!sleeping) {
      const event = await db.select().from(systemEvents).where(eq(systemEvents.id, eventId)).get();
      if (event && (await postEventEnvelope(mind, event))) {
        await markDelivered(eventId);
        // Record the row only on actual delivery — history must not claim the mind
        // heard something it never received (#420).
        await recordEventRow(mind, event);
        return { id: eventId, delivered: true };
      }
      elog.warn(
        `event ${eventId} (${input.type}) for ${mind} was not delivered; ` +
          `left pending for the next wake or mind start`,
      );
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
    // A persistent failure here silently disables the whole notices/events feature
    // (e.g. the migration wasn't applied), so log at error — this is a real defect,
    // not benign noise.
    elog.error(`failed to deliver event to ${mind}`, log.errorData(err));
    return { id: eventId, delivered: false };
  }
}

/** Event types that must never be replayed after the fact — only meaningful live. */
const NO_REPLAY_TYPES = new Set(["sleep"]);

/**
 * Deliver pending immediate events (oldest-first) to a now-awake mind. Called by the
 * sleep manager after the wake event, and on mind start (failed earlier POSTs).
 * Stale rows — `sleep` events (only meaningful at bedtime) and anything older than
 * {@link FLUSH_MAX_AGE_MS} — are stamped expired instead of replayed.
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
      if (NO_REPLAY_TYPES.has(event.type) || eventAgeMs(event.created_at) > FLUSH_MAX_AGE_MS) {
        elog.info(`expiring stale pending event ${event.id} (${event.type}) for ${mind}`);
        await markDelivered(event.id, { expired: true });
        continue;
      }
      if (await postEventEnvelope(mind, event)) {
        await markDelivered(event.id);
        await recordEventRow(mind, event);
        delivered++;
      } else {
        elog.warn(`flush could not deliver event ${event.id} (${event.type}) to ${mind}`);
      }
    }
    return delivered;
  } catch (err) {
    elog.warn(`failed to flush queued events for ${mind}`, log.errorData(err));
    return 0;
  }
}

/** Age of a stored `created_at` (UTC `YYYY-MM-DD HH:MM:SS`) in ms; 0 if unparseable. */
function eventAgeMs(createdAt: string): number {
  const iso = createdAt.endsWith("Z") ? createdAt : `${createdAt.replace(" ", "T")}Z`;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : Date.now() - t;
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

/** The wake-summary line describing queued events, or "" when none are pending. */
export function pendingEventsLine(count: number): string {
  if (count <= 0) return "";
  return `${count} system event${count === 1 ? "" : "s"} arrived while you slept and will follow shortly.`;
}

// --- Next-turn drain (port of the notices context-block path) ---

/**
 * Undrained next-turn events for a mind+thread, oldest first. Includes mind-level
 * events (thread = "") so they reach whichever thread next runs a turn.
 */
export async function drainEvents(
  mind: string,
  thread: string,
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
        or(eq(systemEvents.thread, thread), eq(systemEvents.thread, MIND_LEVEL_THREAD)),
      ),
    )
    .orderBy(asc(systemEvents.id))
    .limit(limit);
}

function metaOf(e: SystemEvent): Record<string, unknown> {
  return parseMeta(e.meta, `event ${e.id}`);
}

const FAILURE_SUBTYPES = new Set(["turn_error", "crash", "startup"]);
const NOTICE_HEADER =
  "[Notices] While you were unavailable, one or more turns failed. You're back now:";

/**
 * Render next-turn events as a context block. Failure notices group identical reasons into
 * one line with a count and time span; budget and version events get their own blocks;
 * extension notices render one line each under a per-extension header. Anything else falls
 * back to a generic block under its worded label — nothing drained may silently vanish
 * (clearDeliveredEvents stamps everything the drain returned). Returns null if empty.
 */
export function formatEvents(events: SystemEvent[]): string | null {
  if (events.length === 0) return null;

  const failures: SystemEvent[] = [];
  const budgets: SystemEvent[] = [];
  const versions: SystemEvent[] = [];
  const extensions: SystemEvent[] = [];
  const others: SystemEvent[] = [];
  for (const e of events) {
    if (e.type === "budget") budgets.push(e);
    else if (e.type === "version") versions.push(e);
    else if (e.type === "notice") {
      const subtype = String(metaOf(e).subtype);
      if (FAILURE_SUBTYPES.has(subtype)) failures.push(e);
      else if (subtype === "extension") extensions.push(e);
      else others.push(e);
    } else others.push(e);
  }

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

  if (others.length > 0) {
    const lines = others.map(
      (e) => `- ${localHM(e.created_at)} (${eventLabel(e.type, metaOf(e))}) ${e.body}`,
    );
    blocks.push(`[Events]\n${lines.join("\n")}`);
  }

  return blocks.join("\n\n");
}

function localHM(createdAt: string): string {
  const iso = createdAt.endsWith("Z") ? createdAt : `${createdAt.replace(" ", "T")}Z`;
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Mark next-turn events delivered for a mind+thread up to and including `uptoId`. Unlike
 * the old notices table (which deleted rows), events persist — we stamp `delivered_at` so
 * they stay visible in the events history/UI.
 */
export async function clearDeliveredEvents(
  mind: string,
  thread: string,
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
          or(eq(systemEvents.thread, thread), eq(systemEvents.thread, MIND_LEVEL_THREAD)),
          lte(systemEvents.id, uptoId),
        ),
      );
  } catch (err) {
    elog.warn(`failed to clear delivered events for ${mind}:${thread}`, log.errorData(err));
  }
}

// --- Status surfaces (ports of latestFailureNotice / latestNotice / hasUndeliveredNotice) ---

export type FailureNotice = { kind: string; reason: string; detail: string; at: string };

let failureReadErrorLogged = false;

/**
 * The most recent undelivered failure notice event for a mind with no completed turn since
 * (across all threads). Used by chat to surface "last turn failed" (#574) — this runs on
 * every minds-list fetch, so the failure filter is pushed into SQL with a LIMIT 1 rather
 * than scanning all pending rows. Null on error.
 */
export async function latestFailureEvent(mind: string): Promise<FailureNotice | null> {
  try {
    const db = await getDb();
    const e = await db
      .select()
      .from(systemEvents)
      .where(
        and(
          eq(systemEvents.mind, mind),
          eq(systemEvents.type, "notice"),
          isNull(systemEvents.delivered_at),
          // Closed set of literal subtypes (not user input).
          sql`json_extract(${systemEvents.meta}, '$.subtype') IN ('turn_error', 'crash', 'startup')`,
        ),
      )
      .orderBy(desc(systemEvents.id))
      .limit(1)
      .get();
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

/** True if the mind has an undelivered next-turn event with this meta.reason (any thread). */
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
 * Store `text` as the reflection on one of `mind`'s own events.
 *
 * Scoped by mind on purpose. The event id reaching here is read out of row metadata, and a
 * mind writes its own history rows — so without the `mind` predicate a mind could name another
 * mind's event id and overwrite that mind's private reflection.
 */
export async function recordReflection(mind: string, eventId: number, text: string): Promise<void> {
  try {
    const db = await getDb();
    await db
      .update(systemEvents)
      .set({ reflection: text })
      .where(and(eq(systemEvents.id, eventId), eq(systemEvents.mind, mind)));
  } catch (err) {
    elog.warn(`failed to record reflection for event ${eventId}`, log.errorData(err));
  }
}

/**
 * Exact reflection attribution, called from turn-lifecycle when a turn completes:
 * the completed turn's `trigger_event_id` points at the mind_history event row that
 * started it (linked by `linkPendingInbound` via the unique `event:<type>:<id>`
 * channel the template echoes back). If that row carries a `systemEventId`, the
 * turn was an event turn and its final text is stored as the event's reflection.
 * A turn triggered by anything else — or with no linked trigger — records nothing:
 * a missing reflection is better than one stolen from an unrelated conversation.
 */
export async function captureReflection(
  mind: string,
  turnId: string | null | undefined,
): Promise<void> {
  if (!turnId) return;
  try {
    const db = await getDb();
    const turn = await db
      .select({ trigger: turns.trigger_event_id })
      .from(turns)
      .where(eq(turns.id, turnId))
      .get();
    if (turn?.trigger == null) return;

    const trigger = await db
      .select({ metadata: mindHistory.metadata })
      .from(mindHistory)
      .where(eq(mindHistory.id, turn.trigger))
      .get();
    const eventId = trigger?.metadata
      ? parseMeta(trigger.metadata, `event row ${turn.trigger}`).systemEventId
      : undefined;
    if (typeof eventId !== "number") return;

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
    if (text) await recordReflection(mind, eventId, text);
  } catch (err) {
    elog.warn(`failed to capture reflection for turn ${turnId}`, log.errorData(err));
  }
}
