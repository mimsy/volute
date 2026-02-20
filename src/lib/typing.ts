const DEFAULT_TTL_MS = 10_000;
const SWEEP_INTERVAL_MS = 5_000;

type Entry = { expiresAt: number };

export class TypingMap {
  private channels = new Map<string, Map<string, Entry>>();
  private sweepTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  set(channel: string, sender: string, opts?: { ttlMs?: number; persistent?: boolean }): void {
    const expiresAt = opts?.persistent ? Infinity : Date.now() + (opts?.ttlMs ?? DEFAULT_TTL_MS);

    let senders = this.channels.get(channel);
    if (!senders) {
      senders = new Map();
      this.channels.set(channel, senders);
    }
    senders.set(sender, { expiresAt });
  }

  delete(channel: string, sender: string): void {
    const senders = this.channels.get(channel);
    if (senders) {
      senders.delete(sender);
      if (senders.size === 0) {
        this.channels.delete(channel);
      }
    }
  }

  /** Remove a sender from all channels (e.g. when a mind finishes processing). */
  deleteSender(sender: string): void {
    for (const [channel, senders] of this.channels) {
      senders.delete(sender);
      if (senders.size === 0) {
        this.channels.delete(channel);
      }
    }
  }

  get(channel: string): string[] {
    const senders = this.channels.get(channel);
    if (!senders) return [];

    const now = Date.now();
    const result: string[] = [];
    for (const [sender, entry] of senders) {
      if (entry.expiresAt > now) {
        result.push(sender);
      }
    }
    return result;
  }

  dispose(): void {
    clearInterval(this.sweepTimer);
    this.channels.clear();
    if (instance === this) instance = undefined;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [channel, senders] of this.channels) {
      for (const [sender, entry] of senders) {
        if (entry.expiresAt <= now) {
          senders.delete(sender);
        }
      }
      if (senders.size === 0) {
        this.channels.delete(channel);
      }
    }
  }
}

let instance: TypingMap | undefined;

export function getTypingMap(): TypingMap {
  if (!instance) {
    instance = new TypingMap();
  }
  return instance;
}
