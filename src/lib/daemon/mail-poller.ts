import { findMind } from "@volute/shared/registry";
import { readSystemsConfig, type SystemsConfig } from "@volute/shared/systems-config";
import { deliverMessage } from "../delivery/message-delivery.js";
import log from "../logger.js";

const mlog = log.child("mail");

export type Email = {
  mind: string;
  id: string;
  from: { address: string; name: string | null };
  subject: string | null;
  body: string | null;
  html: string | null;
  receivedAt: string;
};

type EmailNotification = {
  type: "email";
  mind: string;
  email: Pick<Email, "id" | "subject" | "receivedAt"> & {
    from: { address: string; name: string | null };
  };
};

export function formatEmailContent(email: Pick<Email, "subject" | "body" | "html">): string {
  if (email.body) {
    return email.subject ? `Subject: ${email.subject}\n\n${email.body}` : email.body;
  }
  if (email.html) {
    return email.subject
      ? `Subject: ${email.subject}\n\n[HTML email — plain text not available]`
      : "[HTML email — plain text not available]";
  }
  return email.subject ? `Subject: ${email.subject}` : "[Empty email]";
}

const PING_INTERVAL_MS = 30_000;
const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 60_000;

export class MailPoller {
  private ws: WebSocket | null = null;
  private running = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = INITIAL_RECONNECT_MS;
  private reconnectAttempts = 0;
  private disconnectedAt: string | null = null;
  private config: SystemsConfig | null = null;

  start(): void {
    if (this.running) {
      mlog.warn("already running — ignoring duplicate start");
      return;
    }

    this.config = readSystemsConfig();
    if (!this.config) {
      mlog.info("no systems config — mail disabled");
      return;
    }

    this.running = true;

    this.connect();
  }

  stop(): void {
    this.running = false;
    this.config = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  private connect(): void {
    if (!this.running) return;

    // Refresh config on each reconnect
    this.config = readSystemsConfig();
    if (!this.config) {
      mlog.info("systems config removed — stopping");
      this.stop();
      return;
    }

    const wsUrl = `${this.config.apiUrl.replace(/^http/, "ws")}/api/ws`;

    try {
      // Node.js WebSocket accepts headers in options; TS types don't reflect this
      this.ws = new WebSocket(wsUrl, {
        headers: { Authorization: `Bearer ${this.config!.apiKey}` },
      } as any);
    } catch (err) {
      mlog.warn("failed to create WebSocket", log.errorData(err));
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      if (this.reconnectAttempts > 0) {
        mlog.info(`reconnected after ${this.reconnectAttempts} attempts`);
      }
      mlog.info("connected");
      this.reconnectAttempts = 0;
      this.reconnectDelay = INITIAL_RECONNECT_MS;

      // Catch up on emails missed during disconnection
      if (this.disconnectedAt) {
        this.catchUp(this.disconnectedAt);
        this.disconnectedAt = null;
      }

      // Periodic keepalive
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        try {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send("ping");
          }
        } catch (err) {
          mlog.warn("ping failed", log.errorData(err));
        }
      }, PING_INTERVAL_MS);
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(String(event.data));
    };

    this.ws.onclose = () => {
      mlog.warn("disconnected");
      if (!this.disconnectedAt) {
        this.disconnectedAt = new Date().toISOString();
      }
      this.cleanup();
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      mlog.warn("WebSocket error", log.errorData(err));
      // onclose will fire after this
    };
  }

  private cleanup(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (!this.running) return;

    this.reconnectAttempts++;
    if (this.reconnectAttempts % 10 === 0) {
      mlog.warn(
        `failed to connect ${this.reconnectAttempts} times — check systems config and network`,
      );
    }

    mlog.info(`reconnecting in ${this.reconnectDelay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_MS);
  }

  /** Fetch emails that arrived while disconnected */
  private catchUp(since: string): void {
    if (!this.config) return;

    const url = `${this.config.apiUrl}/api/mail/system/poll?since=${encodeURIComponent(since)}`;

    fetch(url, {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
    })
      .then(async (res) => {
        if (!res.ok) {
          mlog.warn(`catch-up poll failed: HTTP ${res.status}`);
          return;
        }
        const data = (await res.json()) as { emails?: Email[] };
        if (!Array.isArray(data.emails) || data.emails.length === 0) return;

        mlog.info(`catching up on ${data.emails.length} missed emails`);
        for (const email of data.emails) {
          await this.deliver(email.mind, email);
        }
      })
      .catch((err) => {
        mlog.warn("catch-up error", log.errorData(err));
      });
  }

  private handleMessage(data: string): void {
    if (data === "pong") return;

    let msg: { type?: string; mind?: string; email?: EmailNotification["email"] };
    try {
      msg = JSON.parse(data);
    } catch {
      mlog.warn(`received unparseable message: ${data.slice(0, 200)}`);
      return;
    }

    if (msg.type !== "email") return;

    if (!msg.mind || !msg.email?.id) {
      mlog.warn(`received malformed email notification: ${data.slice(0, 500)}`);
      return;
    }

    this.fetchAndDeliver(msg.mind, msg.email).catch((err) => {
      mlog.warn(`failed to process email for ${msg.mind}`, log.errorData(err));
    });
  }

  private async fetchAndDeliver(
    mind: string,
    notification: EmailNotification["email"],
  ): Promise<void> {
    if (!this.config) {
      mlog.warn(`systems config missing — cannot fetch email ${notification.id} for ${mind}`);
      return;
    }

    // Fetch full email content
    const url = `${this.config.apiUrl}/api/mail/emails/${encodeURIComponent(mind)}/${encodeURIComponent(notification.id)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
    });

    if (!res.ok) {
      mlog.warn(`failed to fetch email ${notification.id}: HTTP ${res.status}`);
      return;
    }

    const email = (await res.json()) as Omit<Email, "mind">;
    await this.deliver(mind, { ...email, mind });
  }

  private async deliver(mind: string, email: Email): Promise<void> {
    const entry = findMind(mind);
    if (!entry || !entry.running) {
      mlog.warn(`skipping delivery to ${mind}: ${!entry ? "not found" : "not running"}`);
      return;
    }

    const text = formatEmailContent(email);

    try {
      await deliverMessage(mind, {
        content: [{ type: "text", text }],
        channel: `mail:${email.from.address}`,
        sender: email.from.name || email.from.address,
        platform: "Email",
        isDM: true,
      });
      mlog.info(`delivered email from ${email.from.address} to ${mind}`);
    } catch (err) {
      mlog.warn(`failed to deliver to ${mind}`, log.errorData(err));
    }
  }
}

let instance: MailPoller | null = null;

export function initMailPoller(): MailPoller {
  if (instance) throw new Error("MailPoller already initialized");
  instance = new MailPoller();
  return instance;
}

export function getMailPoller(): MailPoller {
  if (!instance) throw new Error("MailPoller not initialized — call initMailPoller() first");
  return instance;
}

/** Ensure a mail address exists for a mind on volute.systems. Idempotent, logs errors. */
export async function ensureMailAddress(mindName: string): Promise<void> {
  const config = readSystemsConfig();
  if (!config) return;

  try {
    const res = await fetch(`${config.apiUrl}/api/mail/addresses/${encodeURIComponent(mindName)}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      mlog.warn(`failed to ensure address for ${mindName}: HTTP ${res.status}`);
    }
    await res.text().catch(() => {});
  } catch (err) {
    mlog.warn(`failed to ensure address for ${mindName}`, log.errorData(err));
  }
}
