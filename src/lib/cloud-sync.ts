import { deliverMessage } from "./delivery/message-delivery.js";
import log from "./logger.js";
import { getAuthHeaders, getWebhookUrl } from "./webhook.js";

const slog = log.child("cloud-sync");

function getQueueUrl(): string | undefined {
  const base = getWebhookUrl();
  if (!base) return undefined;
  return `${base.replace(/\/$/, "")}/queue`;
}

export async function consumeQueuedMessages(): Promise<void> {
  const queueUrl = getQueueUrl();
  if (!queueUrl) return;

  slog.info("checking cloud queue for pending messages");

  let items: unknown[];
  try {
    const res = await fetch(queueUrl, { headers: getAuthHeaders() });
    if (!res.ok) {
      slog.warn(`cloud queue returned HTTP ${res.status}`);
      return;
    }
    const body = await res.json();
    if (!Array.isArray(body) || body.length === 0) {
      slog.info("no queued cloud messages");
      return;
    }
    items = body;
  } catch (err) {
    slog.warn("failed to fetch cloud queue", log.errorData(err));
    return;
  }

  slog.info(`processing ${items.length} queued cloud message(s)`);

  const acknowledged: string[] = [];
  for (const raw of items) {
    const msg = raw as Record<string, unknown>;
    if (
      !msg.id ||
      typeof msg.id !== "string" ||
      !msg.mind ||
      typeof msg.mind !== "string" ||
      !msg.channel ||
      typeof msg.channel !== "string"
    ) {
      slog.warn("skipping malformed queued message", { msg: JSON.stringify(msg).slice(0, 200) });
      continue;
    }
    try {
      await deliverMessage(msg.mind, {
        channel: msg.channel,
        sender: (msg.sender as string) ?? null,
        content: msg.content,
        conversationId: msg.conversationId as string | undefined,
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
        slog.error(
          `failed to acknowledge ${acknowledged.length} queued messages (HTTP ${res.status}) — these will be re-delivered on next startup`,
        );
      } else {
        slog.info(`acknowledged ${acknowledged.length} queued message(s)`);
      }
    } catch (err) {
      slog.error(
        `failed to acknowledge ${acknowledged.length} queued messages — these will be re-delivered on next startup`,
        log.errorData(err),
      );
    }
  }
}
