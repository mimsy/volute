export type LogEntry = {
  level: string;
  cat?: string;
  msg: string;
  ts: string;
  data?: Record<string, unknown>;
};

type Subscriber = (entry: LogEntry) => void;

class LogBuffer {
  private buffer: (LogEntry | null)[];
  private head = 0;
  private count = 0;
  private subscribers = new Set<Subscriber>();

  constructor(private maxSize = 1000) {
    this.buffer = new Array(maxSize).fill(null);
  }

  append(entry: LogEntry) {
    const idx = (this.head + this.count) % this.maxSize;
    this.buffer[idx] = entry;
    if (this.count === this.maxSize) {
      this.head = (this.head + 1) % this.maxSize;
    } else {
      this.count++;
    }
    for (const sub of this.subscribers) {
      sub(entry);
    }
  }

  getEntries(): LogEntry[] {
    const result: LogEntry[] = [];
    for (let i = 0; i < this.count; i++) {
      result.push(this.buffer[(this.head + i) % this.maxSize]!);
    }
    return result;
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
}

export const logBuffer = new LogBuffer();

/** Exported for testing only */
export function createLogBuffer(maxSize: number): LogBuffer {
  return new LogBuffer(maxSize);
}
