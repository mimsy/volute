import { daemonLoopback, findMind } from "./registry.js";
import { readSystemsConfig } from "./systems-config.js";

export type Email = {
  mind: string;
  id: string;
  from: { address: string; name: string };
  subject: string;
  body: string | null;
  html: string | null;
  receivedAt: string;
};

export class MailPoller {
  private interval: ReturnType<typeof setInterval> | null = null;
  private daemonPort: number | null = null;
  private daemonToken: string | null = null;
  private lastPoll: string | null = null;
  private running = false;

  start(daemonPort?: number, daemonToken?: string): void {
    const config = readSystemsConfig();
    if (!config) {
      console.error("[mail] no systems config — mail polling disabled");
      return;
    }

    this.daemonPort = daemonPort ?? null;
    this.daemonToken = daemonToken ?? null;
    this.lastPoll = new Date().toISOString();
    this.running = true;

    // Poll every 30 seconds
    this.interval = setInterval(() => this.poll(), 30_000);
    console.error("[mail] polling started");
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
    if (!config) return;

    const since = this.lastPoll ?? new Date().toISOString();
    const url = `${config.apiUrl}/api/mail/system/poll?since=${encodeURIComponent(since)}`;

    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });

      if (!res.ok) {
        console.error(`[mail] poll failed: HTTP ${res.status}`);
        return;
      }

      const data = (await res.json()) as { emails: Email[] };

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
      console.error("[mail] poll error:", err);
    }
  }

  private async deliver(mind: string, email: Email): Promise<void> {
    const entry = findMind(mind);
    if (!entry || !entry.running) return;

    const channel = `mail:${email.from.address}`;
    const sender = email.from.name || email.from.address;

    let text: string;
    if (email.body) {
      text = email.subject ? `Subject: ${email.subject}\n\n${email.body}` : email.body;
    } else if (email.html) {
      text = email.subject
        ? `Subject: ${email.subject}\n\n[HTML email — plain text not available]`
        : "[HTML email — plain text not available]";
    } else {
      text = email.subject ? `Subject: ${email.subject}` : "[Empty email]";
    }

    const body = JSON.stringify({
      content: [{ type: "text", text }],
      channel,
      sender,
      platform: "Email",
      isDM: true,
    });

    if (!this.daemonPort || !this.daemonToken) return;

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
