import { resolveApiKey } from "../ai-service.js";
import { hasUndeliveredEvent, recordNotice } from "../chat/system-events.js";
import { getSpiritName } from "../config/setup.js";
import log from "../util/logger.js";

const rlog = log.child("cred-recovery");

/** Reason string on the notice a mind gets when it spawns without credentials. */
export const REASON_FAILED = "oauth_refresh_failed";
/** Reason string on the follow-up notice once the provider recovers. */
export const REASON_RECOVERED = "oauth_refresh_recovered";
/**
 * Reason string on the alert the *host* gets about some other mind. Deliberately
 * distinct from {@link REASON_FAILED}: the spirit is itself a mind that can go down
 * in the same outage, and the undelivered-event dedup keys on the reason alone — a
 * shared string would let an alert about someone else swallow the spirit's own
 * "you started without credentials" notice.
 */
export const REASON_FAILED_HOST = "oauth_refresh_failed_host";

/** First retry delay after a mind spawns credential-less. */
export const INITIAL_RETRY_MS = 60_000;
/** Ceiling on the backoff — a provider outage is re-probed at least this often. */
export const MAX_RETRY_MS = 15 * 60_000;

/** Exponential backoff, capped: 1m, 2m, 4m, 8m, 15m, 15m, … */
export function retryDelayMs(attempt: number): number {
  if (attempt <= 0) return INITIAL_RETRY_MS;
  // 2**attempt overflows to Infinity long before it matters; Math.min still caps.
  return Math.min(INITIAL_RETRY_MS * 2 ** attempt, MAX_RETRY_MS);
}

export type DegradedMind = { provider: string; since: Date };

type TimerHandle = { unref?: () => void };

export type RecoveryDeps = {
  /** Probe for a usable provider key. Defaults to {@link resolveApiKey}. */
  resolveKey?: (provider: string) => Promise<string | undefined>;
  /** Is this mind's process currently up? Defaults to the mind manager. */
  isRunning?: (mind: string) => Promise<boolean>;
  /** Restart a running mind. Defaults to the mind manager. */
  restart?: (mind: string) => Promise<void>;
  /** Schedule the next retry. Defaults to setTimeout. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  /** Cancel a scheduled retry. Defaults to clearTimeout. */
  clearTimer?: (handle: TimerHandle) => void;
};

async function defaultIsRunning(mind: string): Promise<boolean> {
  const { getMindManager } = await import("./mind-manager.js");
  return getMindManager().isRunning(mind);
}

async function defaultRestart(mind: string): Promise<void> {
  const { getMindManager } = await import("./mind-manager.js");
  await getMindManager().restartMind(mind);
}

function failedDetail(provider: string): string {
  return (
    `${provider} authentication was temporarily unavailable (OAuth token refresh is failing), ` +
    `so you started without model credentials and may be unable to respond until it recovers. ` +
    `The daemon is retrying and will restart you automatically once a token comes back — ` +
    `you do not need to do anything, and none of this is your doing.`
  );
}

function recoveredDetail(provider: string, since: Date, until: Date): string {
  const minutes = Math.max(1, Math.round((until.getTime() - since.getTime()) / 60_000));
  // UTC with an explicit marker, matching meta.since. This is the one notice whose
  // whole job is letting a mind date its own silence against its history, so it must
  // not be rendered in whatever zone the daemon host happens to sit in.
  return (
    `${provider} authentication has recovered. You were running without model credentials from ` +
    `${since.toISOString()} to ${until.toISOString()} (UTC; about ${minutes} minute${minutes === 1 ? "" : "s"}). ` +
    `Turns during that window may look empty or truncated in your own history — that gap is the ` +
    `outage, not something you failed to do.`
  );
}

/**
 * Tracks minds that spawned without model credentials because a provider's OAuth
 * refresh was failing, re-probes the provider on a capped backoff, and restarts
 * the affected minds once a token comes back.
 *
 * Before this existed, such a mind logged one line to the daemon journal and then
 * stayed silent until a human noticed and restarted it by hand — on bardo that was
 * four minds for most of a day, each of which then found evidence of its own silence
 * with no explanation for it. The degraded set is deliberately in-memory: a daemon
 * restart re-derives it from the next spawn, and the notice dedup falls back to the
 * mind's own undelivered-event queue so a restart mid-outage doesn't re-notify.
 */
export class CredentialRecovery {
  private degraded = new Map<string, DegradedMind>();
  /** Outage start per mind, surviving the window between a restart and its spawn. */
  private outageStart = new Map<string, Date>();
  /**
   * Minds handed to `restart()` and not yet confirmed either way. They are out of
   * `degraded` so the restart's own spawn can report the truth — a healthy spawn
   * calls `noteHealthy`, a still-credential-less one calls `markDegraded` — but
   * their outage state is held here so neither outcome loses it.
   */
  private pendingRestart = new Map<string, DegradedMind>();
  private timer: TimerHandle | undefined;
  private attempt = 0;
  private recovering = false;
  private rerunRequested = false;
  private stopped = false;

  constructor(private deps: RecoveryDeps = {}) {}

  private resolveKey(provider: string): Promise<string | undefined> {
    return (this.deps.resolveKey ?? resolveApiKey)(provider);
  }

  private isRunning(mind: string): Promise<boolean> {
    return (this.deps.isRunning ?? defaultIsRunning)(mind);
  }

  private restart(mind: string): Promise<void> {
    return (this.deps.restart ?? defaultRestart)(mind);
  }

  /** Minds currently running without credentials, for the status API. */
  get(mind: string): DegradedMind | undefined {
    return this.degraded.get(mind);
  }

  /**
   * The start of this mind's current outage. Recovery removes a mind from the map
   * before its restart proves out, so a re-mark seconds later would otherwise reset
   * `since` to now and under-report the gap the mind is asked to account for.
   * Cleared only when the mind is confirmed healthy.
   */
  private sinceFor(mind: string): Date {
    return this.degraded.get(mind)?.since ?? this.outageStart.get(mind) ?? new Date();
  }

  /** Drop a mind from the degraded set silently — it no longer exists. */
  forget(mind: string): void {
    this.degraded.delete(mind);
    this.pendingRestart.delete(mind);
    this.outageStart.delete(mind);
    if (this.degraded.size === 0) this.reset();
  }

  /**
   * Record that `mind` just spawned without usable `provider` credentials. The
   * first call per outage notifies the mind and the host and arms the retry loop;
   * later spawns while still degraded are silent (the bardo pileup was one notice
   * per spawn, not per outage).
   */
  async markDegraded(mind: string, provider: string): Promise<void> {
    if (this.degraded.has(mind)) {
      this.armTimer();
      return;
    }

    // The spawn of a restart we just issued, reporting back that it is still
    // credential-less. That is the same outage continuing, not a new one: restore the
    // entry with its original start and say nothing. Re-notifying here would emit a
    // second FAILED once the mind has read the first, re-alert the host, and snap the
    // backoff back to a minute on every failed attempt.
    const continuing = this.pendingRestart.get(mind);
    if (continuing) {
      this.degraded.set(mind, continuing);
      this.outageStart.set(mind, continuing.since);
      this.armTimer();
      return;
    }

    // A mind re-marked after a failed recovery keeps the gap's ORIGINAL start, so the
    // recovered notice reports the whole outage rather than only its last attempt.
    const since = this.sinceFor(mind);
    this.degraded.set(mind, { provider, since });
    this.outageStart.set(mind, since);
    rlog.error(
      `${provider} OAuth token refresh is failing for ${mind}; it spawned without credentials — ` +
        `retrying and will restart it automatically when the provider recovers`,
    );

    try {
      // A notice still queued from before a daemon restart covers this outage
      // already — don't stack a second one the mind will read as two events.
      if (!(await hasUndeliveredEvent(mind, REASON_FAILED))) {
        await recordNotice({
          mind,
          thread: "main",
          kind: "startup",
          reason: REASON_FAILED,
          detail: failedDetail(provider),
        });
      }
    } catch (err) {
      rlog.error(`failed to record credential notice for ${mind}`, log.errorData(err));
    }

    await this.alertHost(mind, provider);
    // A newly degraded mind is new information: probe again soon rather than
    // letting it inherit a backoff another mind has already widened to 15m.
    this.attempt = 0;
    this.cancelTimer();
    this.armTimer();
  }

  /**
   * Record that `mind` spawned with usable credentials. Clears any degraded state
   * (with a recovered notice so the mind can date its own gap) without restarting
   * it — it just started — and re-probes on behalf of any minds still degraded.
   */
  async noteHealthy(mind: string): Promise<void> {
    const state = this.degraded.get(mind) ?? this.pendingRestart.get(mind);
    this.degraded.delete(mind);
    this.pendingRestart.delete(mind);
    this.outageStart.delete(mind);
    if (state) await this.notifyRecovered(mind, state);
    if (this.degraded.size === 0) {
      this.reset();
      return;
    }
    if (state) void this.attemptRecovery();
  }

  /**
   * Re-probe every degraded provider once. On success, notifies and restarts the
   * minds that provider left credential-less. Returns true if any provider recovered.
   */
  async attemptRecovery(): Promise<boolean> {
    if (this.stopped) return false;
    if (this.recovering) {
      // A kick that lands mid-pass would otherwise be dropped, and with it the
      // recovery of whatever prompted it. Remember it and run once more.
      this.rerunRequested = true;
      return false;
    }
    if (this.degraded.size === 0) return false;
    this.recovering = true;
    try {
      const providers = new Set([...this.degraded.values()].map((d) => d.provider));
      let recovered = false;
      for (const provider of providers) {
        let key: string | undefined;
        try {
          key = await this.resolveKey(provider);
        } catch (err) {
          rlog.warn(`credential re-probe for ${provider} threw`, log.errorData(err));
          continue;
        }
        if (!key) continue;
        recovered = true;
        await this.recoverProvider(provider);
      }
      if (this.degraded.size === 0) this.reset();
      return recovered;
    } finally {
      this.recovering = false;
      if (this.rerunRequested) {
        this.rerunRequested = false;
        if (!this.stopped && this.degraded.size > 0) void this.attemptRecovery();
      }
      // Deliberately no re-arm here: `tick` re-arms after widening the backoff, and
      // `markDegraded` re-arms from a fresh one. Arming here would pre-empt tick and
      // pin the loop at the initial delay forever.
    }
  }

  private async recoverProvider(provider: string): Promise<void> {
    const affected = [...this.degraded.entries()].filter(([, d]) => d.provider === provider);
    rlog.info(
      `${provider} credentials recovered — restoring ${affected.length} mind(s): ` +
        affected.map(([m]) => m).join(", "),
    );
    for (const [mind, state] of affected) {
      if (this.stopped) return;

      let running: boolean;
      try {
        running = await this.isRunning(mind);
      } catch (err) {
        // We don't know what state the mind is in, so we cannot honestly tell it the
        // outage is over, and we must not start something that may be running.
        // Leave it degraded and ask again on the next tick.
        rlog.warn(`could not determine whether ${mind} is running`, log.errorData(err));
        continue;
      }

      if (!running) {
        // Asleep or deliberately stopped. Starting it here would override a choice
        // nobody asked us to override; its next start picks the credentials up, and
        // the queued notice is waiting when it does.
        rlog.info(`${mind} is not running — leaving it stopped; the notice is queued`);
        this.degraded.delete(mind);
        this.outageStart.delete(mind);
        await this.notifyRecovered(mind, state);
        continue;
      }

      // Hand it to the restart. It leaves `degraded` so its own spawn can report the
      // truth: a healthy spawn calls noteHealthy (which sends the recovered notice),
      // a still-credential-less one calls markDegraded and keeps the original `since`.
      this.degraded.delete(mind);
      this.pendingRestart.set(mind, state);
      try {
        await this.restart(mind);
      } catch (err) {
        // MindStartupError, a health-check timeout, anything. The mind is now neither
        // running nor tracked — putting it back is what keeps the loop alive for it,
        // and it must not be told it recovered when it plainly hasn't.
        rlog.error(`failed to restart ${mind} after credential recovery`, log.errorData(err));
        this.pendingRestart.delete(mind);
        if (!this.degraded.has(mind)) this.degraded.set(mind, state);
        this.outageStart.set(mind, state.since);
        continue;
      } finally {
        const stillPending = this.pendingRestart.get(mind);
        this.pendingRestart.delete(mind);
        // A spawn that reported neither way (a template with no credential injection)
        // would otherwise vanish from the loop — keep it degraded rather than silently
        // forgetting a mind we can't vouch for.
        if (stillPending && !this.degraded.has(mind)) {
          this.degraded.set(mind, stillPending);
        }
      }

      if (this.degraded.has(mind)) {
        rlog.warn(`${mind} restarted but is still without credentials — continuing to retry`);
      }
    }
  }

  private async notifyRecovered(mind: string, state: DegradedMind): Promise<void> {
    try {
      await recordNotice({
        mind,
        thread: "main",
        kind: "startup",
        reason: REASON_RECOVERED,
        detail: recoveredDetail(state.provider, state.since, new Date()),
        meta: { provider: state.provider, since: state.since.toISOString() },
      });
    } catch (err) {
      rlog.error(`failed to record recovery notice for ${mind}`, log.errorData(err));
    }
  }

  /**
   * Tell the host, via the spirit, that a mind is running blind. Journal-only was
   * the original defect: minds cannot read journald, and neither, in practice, did
   * anyone else for a day.
   *
   * TODO: replace with the shared `alertHost(mind, kind, text)` helper once PR2
   * lands it on main — this is that helper's job, done locally in the meantime.
   */
  private async alertHost(mind: string, provider: string): Promise<void> {
    const spirit = getSpiritName();
    if (spirit === mind) return; // the mind's own notice already covers it
    try {
      // The degraded set is in-memory, so without this every daemon restart during
      // an outage stacks another alert per mind onto a spirit that is usually
      // degraded itself and therefore taking no turns — the exact pileup this PR
      // exists to stop, and enough of it to push the spirit's other genuine events
      // past the next-turn cap. Matched on `affectedMind` so an unread alert about
      // one mind still can't suppress the first alert about another.
      if (await hasUndeliveredEvent(spirit, REASON_FAILED_HOST, { affectedMind: mind })) return;
      await recordNotice({
        mind: spirit,
        thread: "main",
        kind: "startup",
        reason: REASON_FAILED_HOST,
        detail:
          `${mind} started without model credentials: ${provider} OAuth token refresh is failing. ` +
          `It cannot respond until the provider recovers. Other minds on this provider are likely ` +
          `affected too — the dashboard marks every mind currently running without credentials. ` +
          `The daemon is retrying and will restart them automatically; if this persists, the host ` +
          `should re-check the ${provider} provider in Settings → Providers.`,
        meta: { provider, affectedMind: mind },
      });
    } catch (err) {
      rlog.error(`failed to alert the host about ${mind}`, log.errorData(err));
    }
  }

  private armTimer(): void {
    if (this.timer || this.degraded.size === 0) return;
    const delay = retryDelayMs(this.attempt);
    const fn = () => {
      this.timer = undefined;
      void this.tick();
    };
    this.timer = this.deps.setTimer ? this.deps.setTimer(fn, delay) : setTimeout(fn, delay);
    // Never hold the event loop open on a retry the daemon isn't waiting for.
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    await this.attemptRecovery();
    if (this.degraded.size > 0) {
      this.attempt++;
      this.armTimer();
    }
  }

  private reset(): void {
    this.attempt = 0;
    this.cancelTimer();
  }

  private cancelTimer(): void {
    if (!this.timer) return;
    if (this.deps.clearTimer) this.deps.clearTimer(this.timer);
    else clearTimeout(this.timer as unknown as NodeJS.Timeout);
    this.timer = undefined;
  }

  /**
   * Stop the retry loop (daemon shutdown). Degraded state is not persisted. Also
   * halts a recovery already in flight, so a restart can't race `stopAll()` and
   * re-spawn a mind the daemon is shutting down.
   */
  stop(): void {
    this.stopped = true;
    this.cancelTimer();
  }
}

let instance: CredentialRecovery | null = null;

export function getCredentialRecovery(): CredentialRecovery {
  if (!instance) instance = new CredentialRecovery();
  return instance;
}

/** Degraded state for one mind, for the status API. */
export function getCredentialDegraded(mind: string): DegradedMind | undefined {
  return getCredentialRecovery().get(mind);
}

/** Register a mind that spawned without usable credentials for `provider`. */
export function markCredentialDegraded(mind: string, provider: string): Promise<void> {
  return getCredentialRecovery().markDegraded(mind, provider);
}

/** Register a mind that spawned with usable credentials. */
export function noteCredentialHealthy(mind: string): Promise<void> {
  return getCredentialRecovery().noteHealthy(mind);
}

/**
 * Drop a deleted mind from the degraded set. Without this a deleted mind keeps the
 * retry loop armed forever and collects recovery notices addressed to a name that
 * no longer exists.
 */
export function forgetCredentialDegraded(mind: string): void {
  getCredentialRecovery().forget(mind);
}
