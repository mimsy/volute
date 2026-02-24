import { getDb } from "./db.js";
import { getDeliveryManager } from "./delivery-manager.js";
import { type DeliveryPayload, extractTextContent } from "./delivery-router.js";
import log from "./logger.js";
import { findMind } from "./registry.js";
import { mindHistory } from "./schema.js";

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

    const manager = getDeliveryManager();
    await manager.routeAndDeliver(mindName, payload);
  } catch (err) {
    dlog.warn(`unexpected error delivering to ${mindName}`, log.errorData(err));
  }
}
