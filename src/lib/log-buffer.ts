export type LogEntry = {
  level: string;
  cat?: string;
  msg: string;
  ts: string;
  data?: Record<string, unknown>;
};

type Subscriber = (entry: LogEntry) => void;

class LogBuffer {
  private entries: LogEntry[] = [];
  private maxSize = 1000;
  private subscribers = new Set<Subscriber>();

  append(entry: LogEntry) {
    this.entries.push(entry);
    if (this.entries.length > this.maxSize) {
      this.entries.shift();
    }
    for (const sub of this.subscribers) {
      sub(entry);
    }
  }

  getEntries(): LogEntry[] {
    return [...this.entries];
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
}

export const logBuffer = new LogBuffer();
