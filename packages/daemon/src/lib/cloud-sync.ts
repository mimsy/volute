import { externalSenderName } from "./chat/puppets.js";
import { deliverMessage } from "./delivery/message-delivery.js";
import log from "./util/logger.js";
import { getAuthHeaders, getWebhookUrl } from "./webhook.js";

const slog = log.child("cloud-sync");

function getQueueUrl(): string | undefined {
  const base = getWebhookUrl();
  if (!base) return undefined;
  return `${base.replace(/\/$/, "")}/queue`;
}

/**
 * The recorded sender for a message relayed off the volute.systems queue.
 *
 * The relay asserts this name; this daemon never authenticated whoever it belongs to, so
 * it is an outside identity and gets namespaced like any other (#1016). `routing.md` now
 * promises minds that a bare sender name is an authenticated Volute account, and a
 * documented guarantee with a silent exception is worse than none — minds reason from it.
 * A name that already carries a namespace is passed through rather than double-prefixed.
 */
export function relaySenderName(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  return raw.includes(":") ? raw : externalSenderName("cloud", raw);
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
        sender: relaySenderName(msg.sender),
        // Null: the cloud queue relays sender text volute.systems recorded — this
        // daemon never authenticated that principal (#1017).
        senderId: null,
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
