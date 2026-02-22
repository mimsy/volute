import { getDb } from "./db.js";
import log from "./logger.js";
import { findMind } from "./registry.js";
import { mindHistory } from "./schema.js";
import { findVariant } from "./variants.js";

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
 * Deliver a message to a mind: persist to mind_history, then forward to mind HTTP server.
 * Fire-and-forget — logs errors but does not throw.
 */
export async function deliverMessage(mindName: string, payload: DeliveryPayload): Promise<void> {
  try {
    const [baseName, variantName] = mindName.split("@", 2);
    const entry = findMind(baseName);
    if (!entry) {
      dlog.warn(`cannot deliver to ${mindName}: mind not found`);
      return;
    }

    // Resolve correct port: variant port if targeting a variant, else base mind port
    let port = entry.port;
    if (variantName) {
      const variant = findVariant(baseName, variantName);
      if (!variant) {
        dlog.warn(`cannot deliver to ${mindName}: variant not found`);
        return;
      }
      port = variant.port;
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

    // Forward to mind server
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
