import { deliverMessage } from "./delivery/message-delivery.js";
import log from "./logger.js";

const slog = log.child("cloud-sync");

type QueuedMessage = {
  id: string;
  mind: string;
  channel: string;
  sender: string | null;
  content: unknown;
  conversationId?: string;
};

function getQueueUrl(): string | undefined {
  const webhookUrl = process.env.VOLUTE_WEBHOOK_URL;
  if (!webhookUrl) return undefined;
  return `${webhookUrl.replace(/\/$/, "")}/queue`;
}

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret = process.env.VOLUTE_WEBHOOK_SECRET;
  if (secret) headers.Authorization = `Bearer ${secret}`;
  return headers;
}

export async function consumeQueuedMessages(): Promise<void> {
  const queueUrl = getQueueUrl();
  if (!queueUrl) return;

  slog.info("checking cloud queue for pending messages");

  let messages: QueuedMessage[];
  try {
    const res = await fetch(queueUrl, { headers: getAuthHeaders() });
    if (!res.ok) {
      slog.warn(`cloud queue returned HTTP ${res.status}`);
      return;
    }
    messages = (await res.json()) as QueuedMessage[];
  } catch (err) {
    slog.warn("failed to fetch cloud queue", log.errorData(err));
    return;
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    slog.info("no queued cloud messages");
    return;
  }

  slog.info(`processing ${messages.length} queued cloud message(s)`);

  const acknowledged: string[] = [];
  for (const msg of messages) {
    try {
      await deliverMessage(msg.mind, {
        channel: msg.channel,
        sender: msg.sender,
        content: msg.content,
        conversationId: msg.conversationId,
      });
      acknowledged.push(msg.id);
    } catch (err) {
      slog.warn(`failed to process queued message ${msg.id}`, log.errorData(err));
    }
  }

  if (acknowledged.length > 0) {
    try {
      const res = await fetch(queueUrl, {
        method: "DELETE",
        headers: getAuthHeaders(),
        body: JSON.stringify({ ids: acknowledged }),
      });
      if (!res.ok) {
        slog.warn(`failed to acknowledge queued messages: HTTP ${res.status}`);
      } else {
        slog.info(`acknowledged ${acknowledged.length} queued message(s)`);
      }
    } catch (err) {
      slog.warn("failed to send queue acknowledgment", log.errorData(err));
    }
  }
}
