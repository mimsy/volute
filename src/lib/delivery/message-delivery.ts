import { eq } from "drizzle-orm";
import { getSleepManagerIfReady } from "../daemon/sleep-manager.js";
import { createTurn } from "../daemon/turn-tracker.js";
import { getDb } from "../db.js";
import { publish as publishMindEvent } from "../events/mind-events.js";
import log from "../logger.js";
import { findMind, getBaseName } from "../registry.js";
import { mindHistory, turns } from "../schema.js";
import { getDeliveryManager } from "./delivery-manager.js";
import { type DeliveryPayload, extractTextContent } from "./delivery-router.js";

const dlog = log.child("delivery");

/**
 * Record an inbound message: persist to mind_history and publish to the live event stream.
 * Both the connector `/message` endpoint and `deliverMessage()` use this to avoid drift.
 */
export async function recordInbound(
  mind: string,
  channel: string,
  sender: string | null,
  content: string | null,
): Promise<void> {
  // Create (or reuse) a turn for this inbound message
  const turnId = await createTurn(mind);

  let eventId: number | undefined;
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
        turn_id: turnId,
      })
      .returning({ id: mindHistory.id });
    eventId = result[0]?.id;

    // Link this event as the turn's trigger
    if (eventId) {
      await db.update(turns).set({ trigger_event_id: eventId }).where(eq(turns.id, turnId));
    }
  } catch (err) {
    dlog.warn(`failed to persist inbound for ${mind}`, log.errorData(err));
  }

  publishMindEvent(mind, {
    mind,
    type: "inbound",
    channel,
    content: content ?? undefined,
  });
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
