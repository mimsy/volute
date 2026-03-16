import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getSleepManagerIfReady } from "../daemon/sleep-manager.js";
import { getActiveTurnId } from "../daemon/turn-tracker.js";
import { getDb } from "../db.js";
import { publish as publishMindEvent } from "../events/mind-events.js";
import log from "../logger.js";
import { findMind, getBaseName } from "../registry.js";
import { conversations, messages, mindHistory, turns } from "../schema.js";
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
  // Record without turn_id initially. The turn will be linked either by
  // tagRecentInbound (when session is known) or retroactively at turn creation.
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
 * Tag recent untagged inbound events and messages for a mind with the given turn ID.
 * Used both proactively (on message delivery) and retroactively (on turn creation).
 * When `setTrigger` is true, also sets the turn's `trigger_event_id` to the most recent inbound.
 */
export async function tagUntaggedInbound(
  mind: string,
  turnId: string,
  { limit = 5, setTrigger = false }: { limit?: number; setTrigger?: boolean } = {},
): Promise<void> {
  const db = await getDb();
  // Tag recent untagged inbound events in mind_history
  const recentInbounds = await db
    .select({ id: mindHistory.id })
    .from(mindHistory)
    .where(
      and(
        eq(mindHistory.mind, mind),
        eq(mindHistory.type, "inbound"),
        sql`${mindHistory.turn_id} IS NULL`,
        sql`${mindHistory.created_at} > datetime('now', '-60 seconds')`,
      ),
    )
    .orderBy(desc(mindHistory.id))
    .limit(limit);
  if (recentInbounds.length > 0) {
    const ids = recentInbounds.map((r) => r.id);
    await db.update(mindHistory).set({ turn_id: turnId }).where(inArray(mindHistory.id, ids));
    if (setTrigger) {
      await db
        .update(turns)
        .set({ trigger_event_id: recentInbounds[0].id })
        .where(eq(turns.id, turnId));
    }
  }
  // Tag recent untagged conversation messages
  const recentMsgs = await db
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversation_id, conversations.id))
    .where(
      and(
        eq(conversations.mind_name, mind),
        sql`${messages.turn_id} IS NULL`,
        sql`${messages.created_at} > datetime('now', '-60 seconds')`,
      ),
    )
    .orderBy(desc(messages.id))
    .limit(limit);
  if (recentMsgs.length > 0) {
    const ids = recentMsgs.map((r) => r.id);
    await db.update(messages).set({ turn_id: turnId }).where(inArray(messages.id, ids));
  }
}

/**
 * Tag the most recent untagged inbound for a mind with the active turn for a session.
 * Called from the delivery manager after routing resolves the session, so incoming
 * messages are linked to the current turn immediately (enabling correct live streaming).
 */
export async function tagRecentInbound(mind: string, session: string): Promise<void> {
  const turnId = getActiveTurnId(mind, session);
  if (!turnId) return;
  try {
    await tagUntaggedInbound(mind, turnId, { limit: 1 });
  } catch (err) {
    dlog.warn(`failed to tag recent inbound for ${mind} with turn ${turnId}`, log.errorData(err));
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
