import log from "./logger.js";
import { daemonLoopback, findMind } from "./registry.js";
import { readSystemsConfig } from "./systems-config.js";

const mlog = log.child("mail");

export type Email = {
  mind: string;
  id: string;
  from: { address: string; name: string };
  subject: string | null;
  body: string | null;
  html: string | null;
  receivedAt: string;
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

export class MailPoller {
  private interval: ReturnType<typeof setInterval> | null = null;
  private daemonPort: number | null = null;
  private daemonToken: string | null = null;
  private lastPoll: string | null = null;
  private running = false;

  start(daemonPort?: number, daemonToken?: string): void {
    if (this.running) {
      mlog.warn("already running — ignoring duplicate start");
      return;
    }

    const config = readSystemsConfig();
    if (!config) {
      mlog.info("no systems config — mail polling disabled");
      return;
    }

    this.daemonPort = daemonPort ?? null;
    this.daemonToken = daemonToken ?? null;
    this.lastPoll = new Date().toISOString();
    this.running = true;

    // Poll every 30 seconds
    this.interval = setInterval(() => this.poll(), 30_000);
    mlog.info("polling started");
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  private async poll(): Promise<void> {
    const config = readSystemsConfig();
    if (!config) {
      mlog.info("systems config removed — stopping mail polling");
      this.stop();
      return;
    }

    const since = this.lastPoll ?? new Date().toISOString();
    const url = `${config.apiUrl}/api/mail/system/poll?since=${encodeURIComponent(since)}`;

    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });

      if (!res.ok) {
        mlog.warn(`poll failed: HTTP ${res.status}`);
        return;
      }

      const data = (await res.json()) as { emails?: Email[] };
      if (!Array.isArray(data.emails)) {
        mlog.warn("poll response missing emails array");
        return;
      }

      for (const email of data.emails) {
        await this.deliver(email.mind, email);
      }

      // Update lastPoll to the latest receivedAt, or now if no emails
      if (data.emails.length > 0) {
        this.lastPoll = data.emails[data.emails.length - 1].receivedAt;
      } else {
        this.lastPoll = new Date().toISOString();
      }
    } catch (err) {
      mlog.warn("poll error", { error: String(err) });
    }
  }

  private async deliver(mind: string, email: Email): Promise<void> {
    const entry = findMind(mind);
    if (!entry || !entry.running) {
      mlog.warn(`skipping delivery to ${mind}: ${!entry ? "not found" : "not running"}`);
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
      mlog.warn(`cannot deliver to ${mind}: daemon port/token not set`);
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
        mlog.warn(`deliver to ${mind} got HTTP ${res.status}`);
      } else {
        mlog.info(`delivered email from ${email.from.address} to ${mind}`);
      }
      await res.text().catch(() => {});
    } catch (err) {
      mlog.warn(`failed to deliver to ${mind}`, { error: String(err) });
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
      mlog.warn(`failed to ensure address for ${mindName}: HTTP ${res.status}`);
    }
    await res.text().catch(() => {});
  } catch (err) {
    mlog.warn(`failed to ensure address for ${mindName}`, { error: String(err) });
  }
}
