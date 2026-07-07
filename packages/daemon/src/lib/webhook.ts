import { type ActivityEvent, subscribe } from "./events/activity-events.js";
import log from "./util/logger.js";

const slog = log.child("webhook");

type WebhookEvent = {
  event: string;
  mind: string;
  data: Record<string, unknown>;
  timestamp?: string;
};

export function getWebhookUrl(): string | undefined {
  return process.env.VOLUTE_WEBHOOK_URL;
}

export function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret = process.env.VOLUTE_WEBHOOK_SECRET;
  if (secret) headers.Authorization = `Bearer ${secret}`;
  return headers;
}

/**
 * Fire-and-forget webhook delivery. Callers do not await the result; the
 * returned promise (which always resolves, never rejects) exists so tests can
 * deterministically wait for delivery to complete instead of sleeping.
 */
export function fireWebhook(event: WebhookEvent): Promise<void> {
  try {
    const url = getWebhookUrl();
    if (!url) return Promise.resolve();
    const payload = { ...event, timestamp: event.timestamp ?? new Date().toISOString() };
    return fetch(url, {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify(payload),
    })
      .then((res) => {
        if (!res.ok) {
          slog.warn(`webhook ${event.event} returned HTTP ${res.status}`);
        }
      })
      .catch((err) => {
        slog.warn(`webhook delivery failed for ${event.event}`, log.errorData(err));
      });
  } catch (err) {
    slog.error(`webhook ${event.event} failed to serialize`, log.errorData(err));
    return Promise.resolve();
  }
}

/** Subscribe to ActivityEvents and forward them to the webhook URL. */
export function initWebhook(): () => void {
  const url = getWebhookUrl();
  if (!url) return () => {};

  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      slog.error(`VOLUTE_WEBHOOK_URL has unsupported protocol: ${parsed.protocol}`);
      return () => {};
    }
  } catch {
    slog.error(`VOLUTE_WEBHOOK_URL is not a valid URL`);
    return () => {};
  }

  slog.info("webhook enabled");

  return subscribe((event: ActivityEvent & { id: number; created_at: string }) => {
    try {
      fireWebhook({
        event: event.type,
        mind: event.mind,
        data: { summary: event.summary, ...event.metadata },
        timestamp: event.created_at,
      });
    } catch (err) {
      slog.error(`failed to fire webhook for ${event.type}`, log.errorData(err));
    }
  });
}
