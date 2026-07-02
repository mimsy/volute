import { and, eq, inArray } from "drizzle-orm";
import { getSleepManagerIfReady } from "../daemon/sleep-manager.js";
import { getDb } from "../db.js";
import { publish as publishMindEvent } from "../events/mind-events.js";
import { findMind, getBaseName } from "../mind/registry.js";
import { activity, messages, mindHistory } from "../schema.js";
import log from "../util/logger.js";
import { getDeliveryManager } from "./delivery-manager.js";
import { type DeliveryPayload, extractTextContent } from "./delivery-router.js";

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
 * `X-Volute-Session` header — the primary attribution path), it passes `turnId` and is
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
 * Deliver a message to a mind via the delivery manager (routes, batches, gates).
 * Fire-and-forget — logs errors but does not throw.
 */
export async function deliverMessage(mindName: string, payload: DeliveryPayload): Promise<void> {
  try {
    const baseName = await getBaseName(mindName);
    const entry = await findMind(baseName);
    if (!entry) {
      dlog.warn(`cannot deliver to ${mindName}: mind not found`);
      return;
    }

    const textContent = extractTextContent(payload.content);
    await recordInbound(baseName, payload.channel, payload.sender ?? null, textContent);

    // Check if mind is sleeping — handle based on whileSleeping or wake triggers
    const sleepManager = getSleepManagerIfReady();
    if (sleepManager?.isSleeping(baseName)) {
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
        return;
      }

      await sleepManager.queueSleepMessage(baseName, payload);
      if (action === "queue-and-wake") {
        sleepManager
          .initiateWake(baseName, { trigger: { channel: payload.channel } })
          .catch((err) => dlog.warn(`failed to trigger-wake ${baseName}`, log.errorData(err)));
      }
      return;
    }

    const manager = getDeliveryManager();
    await manager.routeAndDeliver(mindName, payload);
  } catch (err) {
    dlog.warn(`unexpected error delivering to ${mindName}`, log.errorData(err));
  }
}
