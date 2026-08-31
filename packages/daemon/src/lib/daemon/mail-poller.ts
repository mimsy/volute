import { externalSenderName } from "../chat/puppets.js";
import { readSystemsConfig, type SystemsConfig } from "../config/systems-config.js";
import { deliverMessage } from "../delivery/message-delivery.js";
import { findMind } from "../mind/registry.js";
import log from "../util/logger.js";

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

/** Collapse newlines so sender-controlled text cannot forge extra header lines. */
function flatten(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Render an email for a mind: a `From:`/`Subject:` header block, then the body.
 *
 * The `From:` line is where the sender's self-chosen display name lives. It is
 * deliberately NOT the delivered message's `sender` — that slot records the
 * namespaced `mail:<address>` identity (#1016), because a display name in an email
 * header is chosen by whoever sent the mail and must not sit in the same column as
 * an authenticated Volute username. Rendering it here keeps the human name in front
 * of the mind (it reads "From: Alice Smith <alice@example.com>") while the identity
 * the system records stays unforgeable.
 */
export function formatEmailContent(
  email: Pick<Email, "from" | "subject" | "body" | "html">,
): string {
  // Both fields are chosen by whoever sent the mail, and they now sit in a header block
  // whose shape a mind is taught to trust. An embedded newline would let a sender forge a
  // second header line — or the bracketed participants/prefix framing the daemon itself
  // emits — so flatten them: this block must carry only lines the daemon wrote.
  const headers = [
    `From: ${flatten(email.from.name ? `${email.from.name} <${email.from.address}>` : email.from.address)}`,
  ];
  if (email.subject) headers.push(`Subject: ${flatten(email.subject)}`);
  const header = headers.join("\n");

  if (email.body) return `${header}\n\n${email.body}`;
  if (email.html) return `${header}\n\n[HTML email — plain text not available]`;
  // "[No message body]", not "[Empty email]": the headers above may well carry a subject,
  // and telling a mind the mail is empty directly under its own visible Subject line
  // contradicts what it can see. What is missing is the body, so say that.
  return `${header}\n\n[No message body]`;
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

      // Catch up on emails missed during disconnection. The watermark is only
      // cleared once catch-up fully succeeds (see catchUpAndClear), so a failed
      // fetch retries on the next reconnect instead of silently dropping mail.
      if (this.disconnectedAt) {
        void this.catchUpAndClear(this.disconnectedAt);
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
      // Routine on a box where the upstream recycles connections every 20–40min;
      // logged at info so a healthy flap cadence doesn't read as a warning stream.
      mlog.info("disconnected");
      if (!this.disconnectedAt) {
        this.disconnectedAt = new Date().toISOString();
      }
      this.cleanup();
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      // onclose fires after this; the every-10th-attempt warn in scheduleReconnect
      // escalates a genuinely stuck connection. errorData unwraps the ErrorEvent.
      mlog.info("WebSocket error", log.errorData(err));
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

  /**
   * Run catch-up and advance the watermark only on full success. On any failure
   * (fetch error, non-OK response, delivery throw) the watermark is retained so
   * the next reconnect re-fetches the gap — at-least-once, never dropped.
   */
  private async catchUpAndClear(since: string): Promise<void> {
    try {
      await this.catchUp(since);
    } catch (err) {
      mlog.info("catch-up failed — will retry on next reconnect", log.errorData(err));
      return;
    }
    // Only clear if still on the same connection and no newer disconnect happened
    // during catch-up; otherwise the fresh gap keeps its watermark for retry.
    if (this.disconnectedAt === since && this.ws?.readyState === WebSocket.OPEN) {
      this.disconnectedAt = null;
    }
  }

  /** Fetch and deliver emails that arrived while disconnected. Throws on failure. */
  private async catchUp(since: string): Promise<void> {
    if (!this.config) throw new Error("systems config missing");

    const url = `${this.config.apiUrl}/api/mail/system/poll?since=${encodeURIComponent(since)}`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
    });
    if (!res.ok) {
      throw new Error(`catch-up poll failed: HTTP ${res.status}`);
    }

    const data = (await res.json()) as { emails?: Email[] };
    if (!Array.isArray(data.emails) || data.emails.length === 0) return;

    mlog.info(`catching up on ${data.emails.length} missed emails`);
    for (const email of data.emails) {
      await this.deliver(email.mind, email);
    }
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
    // Deliberate drop for a deleted mind only: no retry can ever succeed, so
    // don't throw (which would pin the catch-up watermark forever). Do NOT
    // pre-check `running` — a sleeping mind has running=false, and deliverMessage
    // queues those for wake; skipping here would drop their mail.
    if (!(await findMind(mind))) {
      mlog.warn(`skipping delivery to ${mind}: mind not found`);
      return;
    }

    const text = formatEmailContent(email);

    // deliverMessage never throws — it logs and returns false on failure, true
    // when delivered/queued/skipped. Throw on false so catch-up retains its
    // watermark and retries: a transiently-down mind must not lose mail.
    const delivered = await deliverMessage(mind, {
      content: [{ type: "text", text }],
      channel: `mail:${email.from.address}`,
      // The address, namespaced — never `from.name`, which the sender chooses for
      // themselves and which would otherwise be recorded in the same `sender` column
      // that holds authenticated Volute usernames (#1016). The display name still
      // reaches the mind, on the `From:` line of the message itself.
      sender: externalSenderName("mail", email.from.address),
      // Null: an email From: address is asserted by the sending server, not
      // authenticated by Volute (#1017).
      senderId: null,
      platform: "Email",
      isDM: true,
    });
    if (!delivered) {
      throw new Error(`delivery to ${mind} failed`);
    }
    mlog.info(`delivered email from ${email.from.address} to ${mind}`);
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
