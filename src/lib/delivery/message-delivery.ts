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

    // Persist inbound message
    try {
      const db = await getDb();
      await db.insert(mindHistory).values({
        mind: baseName,
        type: "inbound",
        channel: payload.channel,
        sender: payload.sender ?? null,
        content: textContent,
      });
    } catch (err) {
      dlog.warn(`failed to persist message for ${baseName}`, log.errorData(err));
    }

    // Publish to mind event stream so live History sees inbound messages
    publishMindEvent(baseName, {
      mind: baseName,
      type: "inbound",
      channel: payload.channel,
      content: textContent,
    });

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
