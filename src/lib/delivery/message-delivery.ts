import { getSleepManagerIfReady } from "../daemon/sleep-manager.js";
import { getDb } from "../db.js";
import { publish as publishMindEvent } from "../events/mind-events.js";
import log from "../logger.js";
import { findMind } from "../registry.js";
import { mindHistory } from "../schema.js";
import { getDeliveryManager } from "./delivery-manager.js";
import { type DeliveryPayload, extractTextContent } from "./delivery-router.js";

const dlog = log.child("delivery");

// Re-export from delivery-router for backwards compatibility
export { type DeliveryPayload, extractTextContent } from "./delivery-router.js";

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
  try {
    const db = await getDb();
    await db.insert(mindHistory).values({
      mind,
      type: "inbound",
      channel,
      sender,
      content,
    });
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
 * Deliver a message to a mind via the delivery manager (routes, batches, gates).
 * Fire-and-forget — logs errors but does not throw.
 */
export async function deliverMessage(mindName: string, payload: DeliveryPayload): Promise<void> {
  try {
    const [baseName] = mindName.split("@", 2);
    const entry = findMind(baseName);
    if (!entry) {
      dlog.warn(`cannot deliver to ${mindName}: mind not found`);
      return;
    }

    const textContent = extractTextContent(payload.content);
    await recordInbound(baseName, payload.channel, payload.sender ?? null, textContent);

    // Check if mind is sleeping — queue or trigger wake
    const sleepManager = getSleepManagerIfReady();
    if (sleepManager?.isSleeping(baseName)) {
      if (sleepManager.checkWakeTrigger(baseName, payload)) {
        await sleepManager.queueSleepMessage(baseName, payload);
        sleepManager
          .initiateWake(baseName, { trigger: { channel: payload.channel } })
          .catch((err) => dlog.warn(`failed to trigger-wake ${baseName}`, log.errorData(err)));
      } else {
        await sleepManager.queueSleepMessage(baseName, payload);
      }
      return;
    }

    const manager = getDeliveryManager();
    await manager.routeAndDeliver(mindName, payload);
  } catch (err) {
    dlog.warn(`unexpected error delivering to ${mindName}`, log.errorData(err));
  }
}
