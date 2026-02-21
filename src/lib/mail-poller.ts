import { daemonLoopback, findMind } from "./registry.js";
import { readSystemsConfig } from "./systems-config.js";

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
  private daemonPort: number | null = null;
  private daemonToken: string | null = null;
  private running = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = INITIAL_RECONNECT_MS;
  private reconnectAttempts = 0;
  private disconnectedAt: string | null = null;

  start(daemonPort?: number, daemonToken?: string): void {
    if (this.running) {
      console.error("[mail] already running — ignoring duplicate start");
      return;
    }

    const config = readSystemsConfig();
    if (!config) {
      console.error("[mail] no systems config — mail disabled");
      return;
    }

    this.daemonPort = daemonPort ?? null;
    this.daemonToken = daemonToken ?? null;
    this.running = true;

    this.connect();
  }

  stop(): void {
    this.running = false;
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

    const config = readSystemsConfig();
    if (!config) {
      console.error("[mail] systems config removed — stopping");
      this.stop();
      return;
    }

    const wsUrl = `${config.apiUrl.replace(/^http/, "ws")}/api/ws`;

    try {
      // Node.js WebSocket accepts headers in options; TS types don't reflect this
      this.ws = new WebSocket(wsUrl, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      } as any);
    } catch (err) {
      console.error("[mail] failed to create WebSocket:", err);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      if (this.reconnectAttempts > 0) {
        console.error(`[mail] reconnected after ${this.reconnectAttempts} attempts`);
      }
      console.error("[mail] connected");
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
          console.error("[mail] ping failed:", err);
        }
      }, PING_INTERVAL_MS);
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(String(event.data));
    };

    this.ws.onclose = () => {
      console.error("[mail] disconnected");
      if (!this.disconnectedAt) {
        this.disconnectedAt = new Date().toISOString();
      }
      this.cleanup();
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.error("[mail] WebSocket error:", err);
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
      console.error(
        `[mail] failed to connect ${this.reconnectAttempts} times — check systems config and network`,
      );
    }

    console.error(
      `[mail] reconnecting in ${this.reconnectDelay}ms (attempt ${this.reconnectAttempts})`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_MS);
  }

  /** Fetch emails that arrived while disconnected */
  private catchUp(since: string): void {
    const config = readSystemsConfig();
    if (!config) return;

    const url = `${config.apiUrl}/api/mail/system/poll?since=${encodeURIComponent(since)}`;

    fetch(url, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    })
      .then(async (res) => {
        if (!res.ok) {
          console.error(`[mail] catch-up poll failed: HTTP ${res.status}`);
          return;
        }
        const data = (await res.json()) as { emails?: Email[] };
        if (!Array.isArray(data.emails) || data.emails.length === 0) return;

        console.error(`[mail] catching up on ${data.emails.length} missed emails`);
        for (const email of data.emails) {
          await this.deliver(email.mind, email);
        }
      })
      .catch((err) => {
        console.error("[mail] catch-up error:", err);
      });
  }

  private handleMessage(data: string): void {
    if (data === "pong") return;

    let msg: { type?: string; mind?: string; email?: EmailNotification["email"] };
    try {
      msg = JSON.parse(data);
    } catch {
      console.error(`[mail] received unparseable message: ${data.slice(0, 200)}`);
      return;
    }

    if (msg.type !== "email") return;

    if (!msg.mind || !msg.email?.id) {
      console.error(`[mail] received malformed email notification: ${data.slice(0, 500)}`);
      return;
    }

    this.fetchAndDeliver(msg.mind, msg.email).catch((err) => {
      console.error(`[mail] failed to process email for ${msg.mind}:`, err);
    });
  }

  private async fetchAndDeliver(
    mind: string,
    notification: EmailNotification["email"],
  ): Promise<void> {
    const config = readSystemsConfig();
    if (!config) {
      console.error(
        `[mail] systems config missing — cannot fetch email ${notification.id} for ${mind}`,
      );
      return;
    }

    // Fetch full email content
    const url = `${config.apiUrl}/api/mail/emails/${encodeURIComponent(mind)}/${encodeURIComponent(notification.id)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });

    if (!res.ok) {
      console.error(`[mail] failed to fetch email ${notification.id}: HTTP ${res.status}`);
      return;
    }

    const email = (await res.json()) as Omit<Email, "mind">;
    await this.deliver(mind, { ...email, mind });
  }

  private async deliver(mind: string, email: Email): Promise<void> {
    const entry = findMind(mind);
    if (!entry || !entry.running) {
      console.error(`[mail] skipping delivery to ${mind}: ${!entry ? "not found" : "not running"}`);
      return;
    }

    const channel = `mail:${email.from.address}`;
    const sender = email.from.name || email.from.address;

    const text = formatEmailContent(email);

    const body = JSON.stringify({
      content: [{ type: "text", text }],
      channel,
      sender,
      platform: "Email",
      isDM: true,
    });

    if (!this.daemonPort || !this.daemonToken) {
      console.error(`[mail] cannot deliver to ${mind}: daemon port/token not set`);
      return;
    }

    const daemonUrl = `http://${daemonLoopback()}:${this.daemonPort}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    try {
      const res = await fetch(`${daemonUrl}/api/minds/${encodeURIComponent(mind)}/message`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.daemonToken}`,
          Origin: daemonUrl,
        },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        console.error(`[mail] deliver to ${mind} got HTTP ${res.status}`);
      } else {
        console.error(`[mail] delivered email from ${email.from.address} to ${mind}`);
      }
      await res.text().catch(() => {});
    } catch (err) {
      console.error(`[mail] failed to deliver to ${mind}:`, err);
    } finally {
      clearTimeout(timeout);
    }
  }
}

let instance: MailPoller | null = null;

export function getMailPoller(): MailPoller {
  if (!instance) instance = new MailPoller();
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
      console.error(`[mail] failed to ensure address for ${mindName}: HTTP ${res.status}`);
    }
    await res.text().catch(() => {});
  } catch (err) {
    console.error(`[mail] failed to ensure address for ${mindName}:`, err);
  }
}
