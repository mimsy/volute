import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { getSleepManagerIfReady } from "../daemon/sleep-manager.js";
import { releaseTurnSlot, takeTurnSlot } from "../daemon/turn-slots.js";
import {
  getActiveTurnId,
  getActiveTurnOwner,
  linkRowsToTurn,
  normalizeThread,
} from "../daemon/turn-tracker.js";
import { getDb } from "../db.js";
import {
  type ActivityEvent,
  activityTimestamp,
  publish as publishActivity,
} from "../events/activity-events.js";
import { publish as publishMindEvent } from "../events/mind-events.js";
import { findMind, getBaseName } from "../mind/registry.js";
import { activity, messages, mindHistory, minds } from "../schema.js";
import log from "../util/logger.js";
import {
  type EnteredTurn,
  getDeliveryManager,
  recordDeferredInbound,
  tryGetDeliveryManager,
} from "./delivery-manager.js";
import {
  type DeliveryPayload,
  extractTextContent,
  getRoutingConfig,
  matchMetaFor,
  resolveDeliveryMode,
  resolveRoute,
  shouldGate,
  toWirePayload,
  type WirePayload,
} from "./delivery-router.js";
import { sinceNoteFor, withSinceNote } from "./since-last-here.js";

const dlog = log.child("delivery");

/**
 * Record an inbound message: persist to mind_history and publish to the live event stream.
 * Both the connector `/message` endpoint and `deliverMessage()` use this to avoid drift.
 * Returns the inserted event ID (if available) for subsequent turn tagging.
 */
export async function recordInbound(
  mind: string,
  channel: string,
  sender: string | null,
  senderId: number | null,
  content: string | null,
): Promise<number | undefined> {
  // Record without turn_id initially. The caller keeps the id on the payload (`historyId`),
  // and the inbound is linked to its turn when the mind acks the delivery
  // (`linkRowsToTurn`) — exactly this row, never a sweep of the channel.
  let insertedId: number | undefined;
  try {
    const db = await getDb();
    const result = await db
      .insert(mindHistory)
      .values({
        mind,
        type: "inbound",
        channel,
        sender,
        sender_id: senderId,
        content,
      })
      .returning({ id: mindHistory.id });
    insertedId = result[0]?.id;
  } catch (err) {
    dlog.warn(`failed to persist inbound for ${mind}`, log.errorData(err));
  }

  publishMindEvent(mind, {
    mind,
    type: "inbound",
    channel,
    content: content ?? undefined,
    sender: sender ?? undefined,
  });

  return insertedId;
}

/**
 * The thread an outbound row came from and that thread's turn, as recorded on the row — or,
 * with no turn, the delivery its sender was running there (`delivery`).
 */
export type TurnStamp = { turnId?: string; thread?: string; delivery?: string };

/**
 * The stamp for a send from `thread` (its `X-Volute-Thread`): the thread itself, and its
 * active turn when it has one — exact, never a sibling thread's (#1173). With no thread
 * ("", "*" and absent alike) the send is of unknown origin and gets neither, for good.
 *
 * `mind` is the base name turns are kept under; `sender` is who is sending — the mind or
 * one of its variants. A variant's thread shares its parent's turn key, so the turn is
 * only this send's when `sender` is the process that opened it; otherwise no turn.
 *
 * A send with no turn is a `silent` mind's run that nothing opened, whose turn is recorded
 * only at its `done` (#1320): it is stamped with the delivery the sender is running there,
 * and that turn takes it (`linkRunToTurn`).
 */
export function turnStamp(
  mind: string,
  thread: string | null | undefined,
  sender: string = mind,
): TurnStamp {
  const t = normalizeThread(thread);
  if (!t) return {};
  const turnId = getActiveTurnOwner(mind, t) === sender ? getActiveTurnId(mind, t) : undefined;
  if (turnId) return { turnId, thread: t };
  const delivery = tryGetDeliveryManager()?.runningDelivery(mind, t, sender);
  return delivery ? { thread: t, delivery } : { thread: t };
}

/** An outbound row's metadata: the delivery it was stamped with (see `turnStamp`). */
export function outboundMetadata(stamp: TurnStamp): string | null {
  return stamp.delivery ? JSON.stringify({ delivery: stamp.delivery }) : null;
}

/**
 * Record an outbound message: persist to mind_history with the stamp the caller resolved
 * (`turnStamp` for a send; a mind event's own turn and thread for echo-text). The caller
 * publishes the SSE event at send time. A row with a thread but no turn yet may be
 * linked later by a `[volute:outbound:NNN]` marker from that thread (via
 * `linkToolResultToTurn`), which publishes it again, then with its turn.
 *
 * Returns the inserted mind_history record ID (used as a correlation key in tool output),
 * or undefined if it could not be persisted.
 */
export async function recordOutbound(
  mind: string,
  channel: string,
  content: string | null,
  opts: TurnStamp & { messageId?: string } = {},
): Promise<number | undefined> {
  try {
    const db = await getDb();
    const result = await db
      .insert(mindHistory)
      .values({
        mind,
        type: "outbound",
        channel,
        content,
        turn_id: opts.turnId || null,
        thread: normalizeThread(opts.thread) ?? null,
        message_id: opts.messageId ?? null,
        metadata: opts.turnId ? null : outboundMetadata(opts),
      })
      .returning({ id: mindHistory.id });
    return result[0]?.id;
  } catch (err) {
    dlog.warn(`failed to persist outbound for ${mind}`, log.errorData(err));
    return undefined;
  }
}

/** A linked activity's row in its turn's event stream. */
async function recordActivityRow(
  mind: string,
  turnId: string,
  thread: string | undefined,
  a: { summary: string; metadata: string | null; created_at: string },
): Promise<void> {
  const db = await getDb();
  await db.insert(mindHistory).values({
    mind,
    type: "activity",
    content: a.summary,
    metadata: a.metadata,
    turn_id: turnId,
    thread: thread ?? null,
    created_at: a.created_at,
  });
}

/**
 * Publish an activity from an extension command, attributed to the turn that ran the
 * command: the caller's thread's exact turn (`turnStamp`), which also gets the
 * activity's mind_history row. The caller is who ran the command, not the mind the
 * activity is about — an admin or the spirit acting `--mind` for another mind ran it
 * in its own turn. With no turn to stamp, the activity waits for its marker.
 */
export async function publishTurnActivity(
  event: ActivityEvent,
  caller: { mind: string; thread?: string; sender: string },
): Promise<number> {
  const stamp = turnStamp(caller.mind, caller.thread, caller.sender);
  const created_at = activityTimestamp();
  const id = await publishActivity({
    ...event,
    created_at,
    ...(stamp.turnId ? { turn_id: stamp.turnId } : {}),
  });
  if (id > 0 && stamp.turnId) {
    // The activity is persisted either way; a missing history row must not cost the
    // command its marker.
    try {
      await recordActivityRow(caller.mind, stamp.turnId, stamp.thread, {
        summary: event.summary,
        metadata: event.metadata ? JSON.stringify(event.metadata) : null,
        created_at,
      });
    } catch (err) {
      dlog.warn(`failed to record activity ${id} in turn ${stamp.turnId}`, log.errorData(err));
    }
  }
  return id;
}

/** Regexes to extract correlation IDs from tool_result content. */
const OUTBOUND_MARKER_RE = /\[volute:outbound:(\d+)\]/g;
const ACTIVITY_MARKER_RE = /\[volute:activity:(\d+)\]/g;

/**
 * Link outbound records and extension activities to a turn using correlation
 * markers in tool_result content. Called from the events endpoint when a
 * tool_result event arrives; `turnId`, `source.thread` and `source.sender` (the
 * process that sent it) are the tool_result's own.
 *
 * A marker is only evidence of where a record came from when nothing else could have
 * printed it: a mind can echo a marker into another thread's tool output (cat-ing its
 * own log), or print any id at all. So linking never overwrites a turn, never crosses
 * threads or minds, and is claimed with `turn_id IS NULL` in the UPDATE itself (#1173).
 *
 * An outbound record with no turn yet is linked when it was sent from this same thread;
 * a send recorded with no thread is never linked. Its linked message gets the same turn
 * and the `source_event_id`, and the outbound is published again with its turn (the send
 * published it before the turn existed). A record already carrying this turn only gets
 * `source_event_id`.
 *
 * Activity markers claim this mind's (or its variants') activities with no turn yet, and
 * add a mind_history row for each. An activity already stamped with this turn at publish
 * (`publishTurnActivity`) only gets `source_event_id`. Activities record no thread, so
 * no thread check is possible for the unstamped ones.
 */
export async function linkToolResultToTurn(
  mind: string,
  turnId: string,
  toolResultContent: string | null,
  toolUseEventId: number | undefined,
  source: { thread?: string | null; sender?: string } = {},
): Promise<void> {
  if (!toolResultContent) return;
  const ownThread = normalizeThread(source.thread);

  const db = await getDb();

  // --- Outbound markers ---
  for (const match of toolResultContent.matchAll(OUTBOUND_MARKER_RE)) {
    const outboundId = Number(match[1]);
    try {
      // Recorded under the sender's own name (a variant's sends under the variant).
      const own = and(
        eq(mindHistory.id, outboundId),
        eq(mindHistory.mind, source.sender ?? mind),
        eq(mindHistory.type, "outbound"),
      );
      const row = await db
        .select({
          message_id: mindHistory.message_id,
          turn_id: mindHistory.turn_id,
          thread: mindHistory.thread,
        })
        .from(mindHistory)
        .where(own)
        .get();
      if (!row) {
        dlog.warn(`outbound marker references missing record: mind=${mind} id=${outboundId}`);
        continue;
      }

      // A send from this same thread with no turn yet is claimed for this one.
      if (row.turn_id == null && row.thread != null && row.thread === ownThread) {
        if ((await claimOutbound(mind, turnId, own, toolUseEventId)) > 0) continue;
      }
      if (row.turn_id !== turnId) {
        dlog.warn(
          `outbound ${outboundId} for ${mind} (turn ${row.turn_id ?? "none"}, thread ${row.thread ?? "none"}) ` +
            `not linked to turn ${turnId} (thread ${ownThread ?? "none"})`,
        );
        continue;
      }
      // Already this turn's: its message gets the source event.
      if (row.message_id) {
        await db
          .update(messages)
          .set({
            turn_id: turnId,
            ...(toolUseEventId != null ? { source_event_id: toolUseEventId } : {}),
          })
          .where(eq(messages.id, Number(row.message_id)));
      }
    } catch (err) {
      dlog.warn(`failed to link outbound ${outboundId} to turn ${turnId}`, log.errorData(err));
    }
  }

  // --- Activity markers ---
  const markerIds: number[] = [];
  for (const match of toolResultContent.matchAll(ACTIVITY_MARKER_RE)) {
    markerIds.push(Number(match[1]));
  }
  if (markerIds.length > 0) {
    try {
      const sourceEvent = toolUseEventId != null ? { source_event_id: toolUseEventId } : {};
      // Stamped at publish by this very turn: only the source event is missing.
      if (toolUseEventId != null) {
        await db
          .update(activity)
          .set(sourceEvent)
          .where(
            and(
              inArray(activity.id, markerIds),
              eq(activity.turn_id, turnId),
              sql`${activity.source_event_id} IS NULL`,
            ),
          );
      }
      // Unstamped: only this mind's own activities (a variant publishes under its own
      // name) — a marker is text a mind can print, and must not pull another mind's
      // activity into its turn. Claimed with `turn_id IS NULL`, so a repeated or echoed
      // marker neither moves an activity nor adds a second history row for it.
      const linked = await db
        .update(activity)
        .set({ turn_id: turnId, ...sourceEvent })
        .where(
          and(
            inArray(activity.id, markerIds),
            sql`${activity.turn_id} IS NULL`,
            or(
              eq(activity.mind, mind),
              inArray(
                activity.mind,
                db.select({ name: minds.name }).from(minds).where(eq(minds.parent, mind)),
              ),
            ),
          ),
        )
        .returning();
      for (const a of linked) await recordActivityRow(mind, turnId, ownThread, a);
    } catch (err) {
      dlog.warn(`failed to link activities to turn ${turnId}`, log.errorData(err));
    }
  }
}

/**
 * Claim the outbound rows `where` selects that have no turn yet for `turnId`, in one UPDATE
 * guarded by `turn_id IS NULL` — a row is never moved off a turn. Their sent messages follow,
 * so the two never name different turns, and each claimed send is published again, now with
 * its turn, so the live view can place it (it was published at send time without one).
 * Returns how many it claimed.
 */
async function claimOutbound(
  mind: string,
  turnId: string,
  where: SQL | undefined,
  sourceEventId?: number,
): Promise<number> {
  const db = await getDb();
  const claimed = await db
    .update(mindHistory)
    .set({ turn_id: turnId })
    .where(and(where, eq(mindHistory.type, "outbound"), isNull(mindHistory.turn_id)))
    .returning({
      channel: mindHistory.channel,
      content: mindHistory.content,
      message_id: mindHistory.message_id,
      thread: mindHistory.thread,
    });
  const messageIds = claimed.flatMap((r) => (r.message_id ? [Number(r.message_id)] : []));
  if (messageIds.length > 0) {
    await db
      .update(messages)
      .set({
        turn_id: turnId,
        ...(sourceEventId != null ? { source_event_id: sourceEventId } : {}),
      })
      .where(inArray(messages.id, messageIds));
  }
  for (const r of claimed) {
    publishMindEvent(mind, {
      mind,
      type: "outbound",
      channel: r.channel ?? undefined,
      content: r.content ?? undefined,
      session: r.thread ?? undefined,
      turnId,
    });
  }
  return claimed.length;
}

/**
 * Give the turn a `done` recorded (a `silent` mind's run that nothing opened, #1320) the
 * sends its run made with no turn to stamp: exactly those `turnStamp` stamped with one of the
 * deliveries the `done` covers, sent by `process` (sends are recorded under the sender's own
 * name) from the thread. Never throws.
 */
export async function linkRunToTurn(
  mind: string,
  process: string,
  session: string,
  turnId: string,
  deliveries: string[],
): Promise<void> {
  const thread = normalizeThread(session);
  if (!thread || deliveries.length === 0) return;
  try {
    await claimOutbound(
      mind,
      turnId,
      and(
        eq(mindHistory.mind, process),
        eq(mindHistory.thread, thread),
        inArray(sql`json_extract(${mindHistory.metadata}, '$.delivery')`, deliveries),
      ),
    );
  } catch (err) {
    dlog.warn(`failed to link run's sends to turn ${turnId}`, log.errorData(err));
  }
}

/**
 * Determine what to do with a message for a sleeping mind.
 * Returns the action to take: "skip", "queue", or "queue-and-wake".
 */
export function resolveSleepAction(
  sleepBehavior: string | undefined,
  wokenByTrigger: boolean,
  wakeTriggerMatches: boolean,
): "skip" | "queue" | "queue-and-wake" {
  if (sleepBehavior === "skip") return "skip";
  if (sleepBehavior === "trigger-wake" && !wokenByTrigger) return "queue-and-wake";
  if (!sleepBehavior && wakeTriggerMatches) return "queue-and-wake";
  return "queue";
}

/**
 * Whether a message will be gated (held, not delivered) for a mind: an unrouted channel
 * with gating enabled and no explicit session. Gated messages are held until the mind opts
 * in, so they must NOT be recorded as inbound history on arrival — the mind hasn't seen
 * them (#420). Resolved from the same routing config the delivery manager uses, so the two
 * stay in lockstep.
 */
type GateMeta = Pick<
  DeliveryPayload,
  "channel" | "sender" | "senderId" | "isDM" | "participantCount" | "session"
>;

async function willGate(baseName: string, payload: GateMeta): Promise<boolean> {
  if (payload.session) return false; // explicit session bypasses routing
  const config = getRoutingConfig(baseName);
  const route = resolveRoute(config, await matchMetaFor(baseName, config, payload));
  return shouldGate(config, route);
}

/**
 * Public will-gate predicate: whether a message to `mindName` on this payload's channel
 * would be held in the gate rather than delivered. Used by the chat API to warn the
 * sender in the 200 response that the message is held pending channel approval (#723).
 * Resolved from the same routing config the delivery manager uses, so the prediction
 * matches what deliverMessage will actually do.
 */
export async function willGateMessage(mindName: string, payload: GateMeta): Promise<boolean> {
  const baseName = await getBaseName(mindName);
  return await willGate(baseName, payload);
}

/**
 * Deliver a message to a mind via the delivery manager (routes, batches, gates).
 * Fire-and-forget for normal callers — logs errors and returns `false` rather than throwing.
 * Returns `true` when the message was handled (delivered, queued, or intentionally skipped).
 *
 * `isFlush` is set only by SleepManager.flushQueuedMessages when a mind wakes. On that path
 * the inbound was already recorded (with its true arrival time) at queue time, and the sleep
 * branch must be bypassed so the message is actually delivered to the now-waking mind rather
 * than re-recorded and re-queued. The returned boolean lets the flush loop delete only
 * genuinely-delivered rows.
 */
/**
 * Whether a delivery to this mind would be held by a spend cap right now. The predictive
 * twin of {@link willGateMessage}, and used for the same purpose: deciding at arrival
 * whether `mind_history` should claim the mind received something.
 *
 * Momentary holds (#823's concurrency gate) don't count. A mind that is merely mid-turn
 * receives what arrives seconds later, so deferring its history row would move every
 * message's recorded arrival time for no reason a reader could ever see.
 */
export function willHoldMessage(baseName: string): boolean {
  const hold = tryGetDeliveryManager()?.holdReason(baseName, "main");
  return hold != null && !hold.momentary;
}

export async function deliverMessage(
  mindName: string,
  payload: DeliveryPayload,
  opts: { isFlush?: boolean } = {},
): Promise<boolean> {
  try {
    const baseName = await getBaseName(mindName);
    const entry = await findMind(baseName);
    if (!entry) {
      dlog.warn(`cannot deliver to ${mindName}: mind not found`);
      return false;
    }

    if (!opts.isFlush) {
      const textContent = extractTextContent(payload.content);

      // Check if mind is sleeping — handle based on whileSleeping or wake triggers.
      // A waking mind (#920) queues here too: it is awake, but its night's backlog is
      // still draining and this message belongs after it.
      const sleepManager = getSleepManagerIfReady();
      if (sleepManager?.isQueueingInbound(baseName)) {
        const sleeping = sleepManager.isSleeping(baseName);
        // Sleeping minds queue the message and flush it on wake — it is not gated here.
        // Record at arrival so history keeps the true receipt time — unless routing will
        // defer it at wake (#420): then the row is written when it actually reaches the mind.
        if (await tryGetDeliveryManager()?.willDefer(baseName, payload)) {
          payload.inboundDeferred = true;
          payload.deferred ??= { at: Date.now() };
        } else {
          payload.historyId = await recordInbound(
            baseName,
            payload.channel,
            payload.sender ?? null,
            payload.senderId,
            textContent,
          );
        }
        const sleepState = sleepManager.getState(baseName);
        // `whileSleeping` speaks to a *sleeping* mind, and a wake trigger has nothing
        // left to wake: while waking, the message is queued unconditionally rather than
        // dropped by a `skip` or spending a no-op wake.
        const action = sleeping
          ? resolveSleepAction(
              payload.whileSleeping,
              sleepState.wokenByTrigger,
              sleepManager.checkWakeTrigger(baseName, payload),
            )
          : "queue";

        if (action === "skip") {
          dlog.info(
            `skipped delivery to ${baseName} (sleeping, whileSleeping=skip, channel=${payload.channel})`,
          );
          return true;
        }

        await sleepManager.queueSleepMessage(baseName, payload);
        if (action === "queue-and-wake") {
          sleepManager
            .initiateWake(baseName, { trigger: { channel: payload.channel } })
            .catch((err) => dlog.warn(`failed to trigger-wake ${baseName}`, log.errorData(err)));
        }
        return true;
      }

      // Awake: a message to an unrouted, gated channel is HELD — the mind never sees it
      // until it routes the channel. Recording it as inbound would claim the mind heard
      // something it didn't, inflating message counts and cluttering history (#420). Skip
      // the history row for gated messages; releaseGated writes the real inbound row when
      // (and if) the held backlog is later delivered.
      //
      // A message held by a spend cap is skipped here for the same reason: the mind is over
      // its cap and will not see this until the period turns over, so recording it now
      // would show a host (and the mind's own history) a message as received that nobody
      // has read. The row is written when it actually arrives — see `inboundDeferred`.
      // The flag rather than a re-check at delivery is what makes it exactly-once: the cap
      // can trip or lift between this line and the POST, and either way the flag says
      // whether history still owes this message a row.
      //
      // A message routing will defer is skipped for the same reason: it waits for the
      // mind's next turn on its thread and is recorded when it rides along with it.
      if (!(await willGate(baseName, payload))) {
        if (
          willHoldMessage(baseName) ||
          (await tryGetDeliveryManager()?.willDefer(baseName, payload))
        )
          payload.inboundDeferred = true;
        else
          payload.historyId = await recordInbound(
            baseName,
            payload.channel,
            payload.sender ?? null,
            payload.senderId ?? null,
            textContent,
          );
      }
    }

    const manager = getDeliveryManager();
    await manager.routeAndDeliver(mindName, payload);
    return true;
  } catch (err) {
    dlog.warn(`unexpected error delivering to ${mindName}`, log.errorData(err));
    return false;
  }
}

/**
 * Deliver a group of already-queued messages to a mind as ONE pre-batched turn —
 * the mind-side router's `dispatchBatch` path — rather than N individual sends.
 * Used by the wake flush (#382): a night's backlog for a channel arrives as a
 * single `[Batch: N messages from X]` turn instead of a burst of cold-start turns.
 *
 * Callers group by channel, so the payloads share a channel and resolve to one
 * session. Returns true only when the mind acks the whole batch; on any failure
 * the caller keeps the group's rows queued for the next wake.
 */
export async function deliverBatch(
  mindName: string,
  payloads: DeliveryPayload[],
): Promise<boolean> {
  if (payloads.length === 0) return true;
  try {
    const baseName = await getBaseName(mindName);
    const entry = await findMind(baseName);
    if (!entry) {
      dlog.warn(`cannot deliver batch to ${mindName}: mind not found`);
      return false;
    }

    // Resolve the target session from routing (payloads share a channel, so one
    // route/session applies). An explicit payload session wins.
    const first = payloads[0];
    const config = getRoutingConfig(baseName);
    const route = resolveRoute(config, await matchMetaFor(baseName, config, first));
    const session = first.session ?? route.session;

    // Routing applies on the wake path as it does awake: if nothing in this backlog would
    // have woken the mind (a deferred thread, or only non-mentions under `mode: "mention"`),
    // waking it for them now would be the same turn it asked not to take. They join the
    // thread's deferred messages instead, to ride along with its next turn. Otherwise the
    // whole backlog goes, the would-be-deferred ones riding along with the rest.
    const manager = tryGetDeliveryManager();
    const deferrals = manager
      ? await Promise.all(payloads.map((p) => manager.deferralFor(baseName, p)))
      : [];
    if (manager && deferrals.every((d) => d != null)) {
      for (const [i, p] of payloads.entries()) {
        // A row that couldn't be written would leave the sleep queue deleting a message
        // kept nowhere. Report failure so this channel's backlog stays queued for the next
        // wake — repeating the ones already kept is better than losing one.
        if (!(await manager.deferMessage(mindName, deferrals[i]!.session, p, deferrals[i]!.until)))
          return false;
      }
      return true;
    }

    // This POSTs straight at the mind rather than going through the delivery queue, so
    // there is no pending row for a redrive sweep to re-offer: the concurrency gate waits
    // here instead of holding. A woken mind's night of backlog is several of these in a
    // row, which is exactly the pile-up #823 exists to stagger.
    const slot = await takeTurnSlot(baseName, session);
    // Tracked like the manager's own deliveries: outstanding until a `done` covers it — the
    // mind names it by `deliveryId` — and in the turn it runs in, entered the moment it holds
    // the slot, before anything else awaits: a message delivered on the thread meanwhile then
    // folds into it, and its sender counts toward the turn's authority (#433). No trigger
    // yet — a rider claimed below may go first.
    const deliveryId = randomUUID();
    const known = () => payloads.map((p) => p.historyId);
    const entering = manager?.beginDirect(baseName, session, mindName, deliveryId, slot.owned, [
      undefined,
      ...known(),
    ]);
    if (slot.timedOut) {
      dlog.warn(
        `delivering a batch to ${baseName}/${session} after waiting ` +
          `${Math.round(slot.waitedMs / 1000)}s for a turn slot — its previous turn is ` +
          `still running, but holding the batch any longer would be worse than the overlap`,
      );
    }
    const wakeAt = slot.owned ? manager?.noteWake(baseName, session) : undefined;

    let riders: Awaited<ReturnType<NonNullable<typeof manager>["claimDeferred"]>> | undefined;
    let ok = false;
    let rejected = false;
    let posting = false;
    let entered: EnteredTurn | undefined;
    try {
      entered = await entering;
      // Deferred messages already waiting on this thread ride along with the turn, first,
      // since they arrived first.
      riders = manager ? await manager.claimDeferred(mindName, session) : undefined;
      // The turn it opened is triggered by its first message — unless a rider leads, whose
      // row is only written on the ack.
      if (entered?.created && !riders?.payloads.length && payloads[0].historyId != null) {
        await linkRowsToTurn(entered.turnId, known());
      }

      // Build the batch payload shape the mind-side router expects. senderId never
      // crosses to the mind process — see WirePayload (#1017) — and neither does daemon
      // bookkeeping: these are being delivered, not deferred.
      const wires: WirePayload[] = [...(riders?.payloads ?? [])];
      for (const p of payloads) {
        const { deferred: _d, inboundDeferred: _i, ...wire } = toWirePayload(p);
        wires.push(wire);
      }
      // A turn this batch starts opens with what the mind's other threads did in between
      // (#939), on its first message. A batch folding into a running turn adds nothing.
      if (slot.owned) {
        const note = await sinceNoteFor(mindName, {
          mind: baseName,
          thread: session,
          channels: wires.map((w) => w.channel),
          conversationIds: wires.map((w) => w.conversationId),
          waited: { ms: slot.waitedMs, behind: slot.behind },
        });
        wires[0] = withSinceNote(wires[0], note);
      }
      const channels: Record<string, WirePayload[]> = {};
      for (const wire of wires) {
        const ch = wire.channel ?? "unknown";
        if (!channels[ch]) channels[ch] = [];
        channels[ch].push(wire);
      }

      posting = true;
      const res = await fetch(`http://127.0.0.1:${entry.port}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session,
          deliveryId,
          batch: { channels },
          interrupt: false,
          replyInstructions: resolveDeliveryMode(config, session).replyInstructions,
        }),
      });
      ok = res.ok;
      rejected = !res.ok;
      if (ok) {
        for (const p of payloads) {
          if (p.inboundDeferred) {
            p.historyId = await recordDeferredInbound(baseName, p, entered?.turnId);
          }
        }
      }
      return ok;
    } finally {
      const riderRows =
        (await riders?.settle(ok ? "acked" : rejected ? "rejected" : "failed", entered?.turnId)) ??
        [];
      const outcome = ok ? "acked" : rejected ? "rejected" : posting ? "failed" : "unsent";
      manager?.endDirect(baseName, session, mindName, deliveryId, entered, outcome, [
        ...riderRows,
        ...known(),
      ]);
      // No turn will run for a batch the mind never took, so the slot must go back — but
      // only if this call took it. `owned: false` means the batch folded into a turn that
      // was already running, whose slot is not ours to give back. Nor did it wake anything.
      if (!ok && slot.owned) releaseTurnSlot(baseName, session);
      if (!ok) manager?.unnoteWake(baseName, session, wakeAt);
    }
  } catch (err) {
    dlog.warn(`unexpected error delivering batch to ${mindName}`, log.errorData(err));
    return false;
  }
}
