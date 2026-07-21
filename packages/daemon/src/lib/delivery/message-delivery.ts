import { and, eq, inArray } from "drizzle-orm";
import { getSleepManagerIfReady } from "../daemon/sleep-manager.js";
import { getDb } from "../db.js";
import { publish as publishMindEvent } from "../events/mind-events.js";
import { findMind, getBaseName } from "../mind/registry.js";
import { activity, messages, mindHistory } from "../schema.js";
import log from "../util/logger.js";
import { getDeliveryManager } from "./delivery-manager.js";
import {
  type DeliveryPayload,
  extractTextContent,
  getRoutingConfig,
  resolveRoute,
  shouldGate,
} from "./delivery-router.js";

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
  content: string | null,
): Promise<number | undefined> {
  // Record without turn_id initially. The inbound is linked to its turn when the turn is
  // created (TurnLifecycle.linkPendingInbound), scoped by the turn's session and channel.
  // This avoids merging unrelated inbounds from different channels into one turn.
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
 * Record an outbound message: persist to mind_history.
 *
 * When the caller knows the sending mind's active turn (resolved from the per-request
 * `X-Volute-Thread` header — the primary attribution path), it passes `turnId` and is
 * responsible for publishing the SSE event itself. When `turnId` is omitted (e.g. a
 * sessionless path), the record is left untagged and its turn is resolved later when the
 * corresponding tool_result event arrives with a `[volute:outbound:NNN]` marker (via
 * `linkToolResultToTurn`), which also publishes the SSE event then.
 *
 * Returns the inserted mind_history record ID (used as a correlation key in tool output).
 */
export async function recordOutbound(
  mind: string,
  channel: string,
  content: string | null,
  opts: { messageId?: string; turnId?: string } = {},
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
        turn_id: opts.turnId ?? null,
        message_id: opts.messageId ?? null,
      })
      .returning({ id: mindHistory.id });
    return result[0]?.id;
  } catch (err) {
    dlog.warn(`failed to persist outbound for ${mind}`, log.errorData(err));
    return undefined;
  }
}

/** Regexes to extract correlation IDs from tool_result content. */
const OUTBOUND_MARKER_RE = /\[volute:outbound:(\d+)\]/g;
const ACTIVITY_MARKER_RE = /\[volute:activity:(\d+)\]/g;

/**
 * Link outbound records and extension activities to a turn using correlation
 * markers in tool_result content. Called from the events endpoint when a
 * tool_result event arrives.
 *
 * Scans the content for `[volute:outbound:NNN]` and `[volute:activity:NNN]`
 * markers. For outbound markers:
 * - Sets the outbound record's turn_id
 * - Fixes the linked message's turn_id and source_event_id
 * - Publishes the outbound event to SSE (correctly tagged)
 * For activity markers:
 * - Sets the activity record's turn_id and source_event_id
 */
export async function linkToolResultToTurn(
  mind: string,
  turnId: string,
  toolResultContent: string | null,
  toolUseEventId: number | undefined,
): Promise<void> {
  if (!toolResultContent) return;

  const db = await getDb();

  // --- Outbound markers ---
  for (const match of toolResultContent.matchAll(OUTBOUND_MARKER_RE)) {
    const outboundId = Number(match[1]);
    try {
      const rows = await db
        .select({
          id: mindHistory.id,
          channel: mindHistory.channel,
          content: mindHistory.content,
          message_id: mindHistory.message_id,
          turn_id: mindHistory.turn_id,
        })
        .from(mindHistory)
        .where(and(eq(mindHistory.id, outboundId), eq(mindHistory.mind, mind)))
        .limit(1);

      const row = rows[0];
      if (!row) {
        dlog.warn(`outbound marker references missing record: mind=${mind} id=${outboundId}`);
        continue;
      }

      // Direct attribution (session header at send time) is the primary path: if the
      // outbound already carries a turn_id, the sender already tagged and published it.
      // Only fill in source_event_id on the linked message; don't re-tag or re-publish.
      const alreadyTagged = row.turn_id != null;
      if (!alreadyTagged) {
        await db.update(mindHistory).set({ turn_id: turnId }).where(eq(mindHistory.id, outboundId));
      }

      if (row.message_id) {
        await db
          .update(messages)
          .set({
            turn_id: turnId,
            ...(toolUseEventId != null ? { source_event_id: toolUseEventId } : {}),
          })
          .where(eq(messages.id, Number(row.message_id)));
      }

      // Publish the outbound event to SSE — correctly tagged. Skipped when the sender
      // already published it via direct attribution to avoid a duplicate stream event.
      if (!alreadyTagged) {
        publishMindEvent(mind, {
          mind,
          type: "outbound",
          channel: row.channel ?? undefined,
          content: row.content ?? undefined,
          turnId,
        });
      }
    } catch (err) {
      dlog.warn(`failed to link outbound ${outboundId} to turn ${turnId}`, log.errorData(err));
    }
  }

  // --- Activity markers ---
  const activityIds: number[] = [];
  for (const match of toolResultContent.matchAll(ACTIVITY_MARKER_RE)) {
    activityIds.push(Number(match[1]));
  }
  if (activityIds.length > 0) {
    try {
      await db
        .update(activity)
        .set({
          turn_id: turnId,
          ...(toolUseEventId != null ? { source_event_id: toolUseEventId } : {}),
        })
        .where(inArray(activity.id, activityIds));

      // Insert mind_history rows so activities appear in the turn event stream
      const actRows = await db.select().from(activity).where(inArray(activity.id, activityIds));
      if (actRows.length > 0) {
        await db.insert(mindHistory).values(
          actRows.map((a) => ({
            mind,
            type: "activity",
            content: a.summary,
            metadata: a.metadata,
            turn_id: turnId,
            created_at: a.created_at,
          })),
        );
      }
    } catch (err) {
      dlog.warn(`failed to link activities to turn ${turnId}`, log.errorData(err));
    }
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
  "channel" | "sender" | "isDM" | "participantCount" | "session"
>;

function willGate(baseName: string, payload: GateMeta): boolean {
  if (payload.session) return false; // explicit session bypasses routing
  const config = getRoutingConfig(baseName);
  const route = resolveRoute(config, {
    channel: payload.channel,
    sender: payload.sender ?? undefined,
    isDM: payload.isDM,
    participantCount: payload.participantCount,
  });
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
  return willGate(baseName, payload);
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

      // Check if mind is sleeping — handle based on whileSleeping or wake triggers
      const sleepManager = getSleepManagerIfReady();
      if (sleepManager?.isSleeping(baseName)) {
        // Sleeping minds queue the message and flush it on wake — it is not gated here.
        // Record at arrival so history keeps the true receipt time.
        await recordInbound(baseName, payload.channel, payload.sender ?? null, textContent);
        const sleepState = sleepManager.getState(baseName);
        const action = resolveSleepAction(
          payload.whileSleeping,
          sleepState.wokenByTrigger,
          sleepManager.checkWakeTrigger(baseName, payload),
        );

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
      if (!willGate(baseName, payload)) {
        await recordInbound(baseName, payload.channel, payload.sender ?? null, textContent);
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

    // Build the batch payload shape the mind-side router expects.
    const channels: Record<string, DeliveryPayload[]> = {};
    for (const p of payloads) {
      const ch = p.channel ?? "unknown";
      if (!channels[ch]) channels[ch] = [];
      channels[ch].push(p);
    }

    // Resolve the target session from routing (payloads share a channel, so one
    // route/session applies). An explicit payload session wins; a file route (which
    // sleep-queued mind messages never hit) falls back to the default session.
    const first = payloads[0];
    const route = resolveRoute(getRoutingConfig(baseName), {
      channel: first.channel,
      sender: first.sender ?? undefined,
      isDM: first.isDM,
      participantCount: first.participantCount,
    });
    const session = first.session ?? (route.destination === "mind" ? route.session : "main");

    const res = await fetch(`http://127.0.0.1:${entry.port}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session, batch: { channels }, interrupt: false }),
    });
    return res.ok;
  } catch (err) {
    dlog.warn(`unexpected error delivering batch to ${mindName}`, log.errorData(err));
    return false;
  }
}
