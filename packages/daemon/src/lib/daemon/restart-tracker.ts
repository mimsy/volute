const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY = 3000;
const DEFAULT_MAX_DELAY = 60000;

export class RestartTracker {
  private attempts = new Map<string, number>();
  private healthyTimers = new Map<string, NodeJS.Timeout>();
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

  /**
   * Arm a reset for a child that has just been spawned: if it is still up
   * `baseDelay` later, its crash budget is cleared. The caller must
   * `cancelHealthyReset()` when the child exits, so a child that dies before the
   * threshold keeps its accumulated count.
   *
   * Resetting at spawn time instead — what both managers used to do — let a child
   * that starts and dies immediately refresh its own budget on every attempt, so
   * the cap and the backoff never engaged (#1033). The threshold is `baseDelay`
   * deliberately: a run shorter than the delay we'd wait before the next attempt
   * is not evidence of health, and it keeps this to one number rather than two.
   *
   * `onReset` fires only when the reset actually cleared a non-zero count.
   */
  armHealthyReset(key: string, onReset?: () => void): void {
    this.cancelHealthyReset(key);
    const timer = setTimeout(() => {
      this.healthyTimers.delete(key);
      if (this.attempts.delete(key)) onReset?.();
    }, this.baseDelay);
    // Never hold the daemon (or a test process) open on a pending reset.
    timer.unref?.();
    this.healthyTimers.set(key, timer);
  }

  /** Cancel a pending healthy reset — the child exited before it earned one. */
  cancelHealthyReset(key: string): void {
    const timer = this.healthyTimers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    this.healthyTimers.delete(key);
  }

  reset(key: string): boolean {
    this.cancelHealthyReset(key);
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
    for (const key of [...this.healthyTimers.keys()]) this.cancelHealthyReset(key);
    this.attempts.clear();
  }
}
