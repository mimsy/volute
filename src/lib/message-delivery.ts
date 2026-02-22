import { getDb } from "./db.js";
import log from "./logger.js";
import { findMind } from "./registry.js";
import { mindHistory } from "./schema.js";

const dlog = log.child("delivery");

export interface DeliveryPayload {
  channel: string;
  sender: string | null;
  content: unknown; // string or content block array
  conversationId?: string;
  typing?: string[];
  platform?: string;
  isDM?: boolean;
  participants?: string[];
  participantCount?: number;
}

export function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as { type: string; text?: string }[])
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text)
      .join("\n");
  }
  return JSON.stringify(content);
}

/**
 * Deliver a message to a mind via the delivery manager (routes, batches, gates).
 * Falls back to direct HTTP delivery if the delivery manager is not initialized.
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

    // Try delivery manager first (handles routing, batching, gating)
    try {
      const { getDeliveryManager } = await import("./delivery-manager.js");
      const manager = getDeliveryManager();
      await manager.routeAndDeliver(mindName, payload);
      return;
    } catch (err) {
      // Delivery manager not initialized — fall back to direct delivery
      if (err instanceof Error && !err.message.includes("not initialized")) {
        dlog.warn("delivery manager error, falling back to direct delivery", log.errorData(err));
      }
    }

    // Fallback: direct HTTP delivery (pre-delivery-manager behavior)
    const { findVariant } = await import("./variants.js");
    const [, variantName] = mindName.split("@", 2);
    let port = entry.port;
    if (variantName) {
      const variant = findVariant(baseName, variantName);
      if (!variant) {
        dlog.warn(`cannot deliver to ${mindName}: variant not found`);
        return;
      }
      port = variant.port;
    }

    const body = JSON.stringify(payload);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        dlog.warn(`mind ${mindName} responded ${res.status}: ${text}`);
      } else {
        await res.text().catch(() => {});
      }
    } catch (err) {
      dlog.warn(`failed to deliver to ${mindName}`, log.errorData(err));
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    dlog.warn(`unexpected error delivering to ${mindName}`, log.errorData(err));
  }
}
