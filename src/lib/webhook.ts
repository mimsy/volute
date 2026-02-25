import { type ActivityEvent, subscribe } from "./events/activity-events.js";
import log from "./logger.js";

const slog = log.child("webhook");

type WebhookEvent = {
  event: string;
  mind: string;
  data: Record<string, unknown>;
  timestamp: string;
};

function getWebhookUrl(): string | undefined {
  return process.env.VOLUTE_WEBHOOK_URL;
}

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = process.env.VOLUTE_DAEMON_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export function fireWebhook(event: WebhookEvent): void {
  const url = getWebhookUrl();
  if (!url) return;
  fetch(url, {
    method: "POST",
    headers: getAuthHeaders(),
    body: JSON.stringify(event),
  }).catch((err) => {
    slog.warn(`webhook delivery failed for ${event.event}`, log.errorData(err));
  });
}

/** Subscribe to ActivityEvents and forward them to the webhook URL. */
export function initWebhook(): () => void {
  const url = getWebhookUrl();
  if (!url) return () => {};

  slog.info(`webhook enabled: ${url}`);

  return subscribe((event: ActivityEvent & { id: number; created_at: string }) => {
    fireWebhook({
      event: event.type,
      mind: event.mind,
      data: { summary: event.summary, ...event.metadata },
      timestamp: event.created_at,
    });
  });
}
