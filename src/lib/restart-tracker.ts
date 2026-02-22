const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY = 3000;
const DEFAULT_MAX_DELAY = 60000;

export class RestartTracker {
  private attempts = new Map<string, number>();
  private maxAttempts: number;
  private baseDelay: number;
  private maxDelay: number;

  constructor(opts?: { maxAttempts?: number; baseDelay?: number; maxDelay?: number }) {
    this.maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseDelay = opts?.baseDelay ?? DEFAULT_BASE_DELAY;
    this.maxDelay = opts?.maxDelay ?? DEFAULT_MAX_DELAY;
  }

  recordCrash(key: string): { shouldRestart: boolean; delay: number; attempt: number } {
    const attempts = this.attempts.get(key) ?? 0;
    if (attempts >= this.maxAttempts) {
      return { shouldRestart: false, delay: 0, attempt: attempts };
    }
    const delay = Math.min(this.baseDelay * 2 ** attempts, this.maxDelay);
    this.attempts.set(key, attempts + 1);
    return { shouldRestart: true, delay, attempt: attempts + 1 };
  }

  reset(key: string): boolean {
    return this.attempts.delete(key);
  }

  getAttempts(key: string): number {
    return this.attempts.get(key) ?? 0;
  }

  get maxRestartAttempts(): number {
    return this.maxAttempts;
  }

  /** Bulk-load attempts from a Map (for persistence). */
  load(data: Map<string, number>): void {
    this.attempts = new Map(data);
  }

  /** Export current attempts as a Map (for persistence). */
  save(): Map<string, number> {
    return new Map(this.attempts);
  }

  clear(): void {
    this.attempts.clear();
  }
}
