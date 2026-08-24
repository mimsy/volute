import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stateDir, voluteSystemDir } from "../mind/registry.js";
import log from "../util/logger.js";

const tlog = log.child("spend-budget");

/** A day. A host bounds a mind in dollars per day, not dollars per hour. */
export const DEFAULT_SPEND_PERIOD_MINUTES = 1440;
/** The system bucket is always a day — `systemSpendCapPerDay` says so in its name. */
const SYSTEM_PERIOD_MINUTES = 1440;

type BudgetState = {
  /** USD spent in the current period. */
  spentUsd: number;
  periodStart: number;
  periodMinutes: number;
  /** USD cap for the period. */
  capUsd: number;
  /**
   * At least one turn this period could not be priced — an unknown or unpriced
   * model, or the partial token counts an un-upgraded mind emits. `spentUsd` is
   * then a floor, not a total, and surfaces should say so rather than presenting
   * an incomplete figure as exact.
   */
  hasUnpricedTurns: boolean;
  warningInjected: boolean;
  exceededNotified: boolean;
};

export type BudgetStatus = "ok" | "warning" | "exceeded";

/** Which cap a mind is up against — its own, or the whole install's. */
export type BudgetScope = "mind" | "system";

export type BudgetCheck = {
  status: BudgetStatus;
  /** The bucket that produced a non-"ok" status; null when status is "ok". */
  scope: BudgetScope | null;
};

function newState(capUsd: number, periodMinutes: number): BudgetState {
  return {
    spentUsd: 0,
    periodStart: Date.now(),
    periodMinutes,
    capUsd,
    hasUnpricedTurns: false,
    warningInjected: false,
    exceededNotified: false,
  };
}

/** How far into a bucket the spend is, ignoring whether anyone has been told. */
function levelOf(state: BudgetState): BudgetStatus {
  const pct = state.spentUsd / state.capUsd;
  if (pct >= 1) return "exceeded";
  if (pct >= 0.8) return "warning";
  return "ok";
}

/** Instant the current period rolls over, as epoch millis. */
function periodEnd(state: BudgetState): number {
  return state.periodStart + state.periodMinutes * 60_000;
}

export class SpendBudget {
  private budgets = new Map<string, BudgetState>();
  /** Install-wide bucket, or null when no system cap is configured. */
  private system: BudgetState | null = null;
  /**
   * Which minds have already been told about the *install-wide* cap this system
   * period. Keyed per mind because a system-cap notice goes to every mind — a
   * single flag on the system bucket would let the first mind's notice silence all
   * the rest, and with no per-mind caps configured (the common case for an
   * install-wide cap) every other mind would hit the cap in silence.
   *
   * Deliberately separate from the per-mind bucket's own `warningInjected` /
   * `exceededNotified`: the two buckets roll over on different clocks, so sharing
   * one flag means either a mind's own cap goes unannounced because a system notice
   * consumed the flag, or a system notice repeats because the mind's period rolled
   * mid-system-day. In memory only — re-announcing once after a daemon restart
   * beats staying silent.
   */
  private systemAcks = new Map<string, { warned: boolean; exceeded: boolean }>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private dirty = new Set<string>();
  private systemDirty = false;

  start(): void {
    this.interval = setInterval(() => {
      this.tick().catch((err) => tlog.error("spend budget tick failed", log.errorData(err)));
    }, 60_000);
  }

  async stop(): Promise<void> {
    await this.flush();
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  /** @param capUsd dollars per period. A non-positive cap sets none. */
  setBudget(mind: string, capUsd: number, periodMinutes: number): void {
    if (capUsd <= 0) return;
    const existing = this.budgets.get(mind);
    if (existing) {
      // A cap that actually changed is a new fact about this period, so the mind
      // gets to be told about the new one — a standing notice named a number that
      // no longer binds. Re-setting the same cap (every boot and wake calls this)
      // must not re-announce anything.
      if (existing.capUsd !== capUsd || existing.periodMinutes !== periodMinutes) {
        existing.warningInjected = false;
        existing.exceededNotified = false;
        this.dirty.add(mind);
      }
      existing.capUsd = capUsd;
      existing.periodMinutes = periodMinutes;
    } else {
      // Try to load persisted state first
      const persisted = this.loadState(this.mindStatePath(mind));
      if (persisted) {
        persisted.capUsd = capUsd;
        persisted.periodMinutes = periodMinutes;
        this.budgets.set(mind, persisted);
      } else {
        this.budgets.set(mind, newState(capUsd, periodMinutes));
      }
    }
  }

  /**
   * Drop a stopped mind's bucket. Flushes first: `flush()` skips a mind whose bucket
   * is already gone, so deleting outright would discard up to a tick's worth of
   * recorded spend — which a crash-looping mind would shed on every restart.
   */
  async removeBudget(mind: string): Promise<void> {
    const state = this.budgets.get(mind);
    if (state && this.dirty.has(mind)) {
      this.dirty.delete(mind);
      await this.saveState(this.mindStatePath(mind), state).catch(() => {});
    }
    this.budgets.delete(mind);
    this.systemAcks.delete(mind);
  }

  /**
   * Install-wide cap in dollars per day. Every mind's spend counts against it, and
   * once it is exhausted every mind is over budget regardless of its own cap.
   * A null or non-positive cap clears it.
   */
  setSystemCap(capUsdPerDay: number | null | undefined): void {
    if (!capUsdPerDay || capUsdPerDay <= 0) {
      this.system = null;
      // Nothing left to write for a bucket that no longer exists. The last flushed
      // figure stays on disk, so re-enabling the cap the same day resumes from it —
      // losing at most the seconds since the last flush, as a crash would.
      this.systemDirty = false;
      this.systemAcks.clear();
      return;
    }
    if (this.system) {
      this.system.capUsd = capUsdPerDay;
      return;
    }
    const persisted = this.loadState(this.systemStatePath());
    if (persisted) {
      persisted.capUsd = capUsdPerDay;
      persisted.periodMinutes = SYSTEM_PERIOD_MINUTES;
      this.system = persisted;
    } else {
      this.system = newState(capUsdPerDay, SYSTEM_PERIOD_MINUTES);
    }
  }

  /**
   * Record one turn's cost against the mind's bucket and the system bucket.
   *
   * `costUsd === null` means the turn could not be priced (an unknown or unpriced
   * model, or the partial token counts an un-upgraded mind emits — both land as a
   * null `cost_usd`). It accumulates nothing, since a guessed number would be worse
   * than a missing one, but flags the period as incomplete.
   */
  recordUsage(mind: string, costUsd: number | null): void {
    const state = this.budgets.get(mind);
    for (const target of [state, this.system]) {
      if (!target) continue;
      if (costUsd === null) {
        // A cap that can't see a turn's cost can't be reached by it. Say so once per
        // period rather than leaving a host who set a limit believing it's holding:
        // an un-upgraded mind, or a model the pricing catalog doesn't carry, can
        // otherwise run all period at an unmoving $0.
        if (!target.hasUnpricedTurns) {
          tlog.warn(
            `${mind}: a turn could not be priced, so it counts $0 against ` +
              `${target === this.system ? "the install-wide cap" : "this mind's cap"}. ` +
              "Its model is unknown to the pricing catalog, or the mind predates cache " +
              "accounting and needs `volute mind upgrade`. The cap cannot bind on " +
              "spend it cannot see.",
          );
        }
        target.hasUnpricedTurns = true;
      } else target.spentUsd += costUsd;
    }
    if (state) this.dirty.add(mind);
    if (this.system) this.systemDirty = true;
  }

  /**
   * Budget status for a mind across both its own cap and the system cap. Does not
   * mutate — call acknowledgeWarning() after delivering a warning.
   */
  checkBudget(mind: string): BudgetCheck {
    const mindState = this.budgets.get(mind);
    const mindLevel = mindState ? levelOf(mindState) : "ok";
    const systemLevel = this.system ? levelOf(this.system) : "ok";

    // The system bucket wins a tie: telling a mind it spent its own budget when the
    // install's cap is what tripped would be false.
    if (systemLevel === "exceeded") return { status: "exceeded", scope: "system" };
    if (mindLevel === "exceeded") return { status: "exceeded", scope: "mind" };
    // Each cap gets its own heads-up, once per that cap's period. "The install is
    // near its budget" and "you are near yours" are different facts a mind acts on
    // differently, so one must not swallow the other.
    if (systemLevel === "warning" && !this.systemAcks.get(mind)?.warned)
      return { status: "warning", scope: "system" };
    if (mindLevel === "warning" && mindState && !mindState.warningInjected)
      return { status: "warning", scope: "mind" };
    return { status: "ok", scope: null };
  }

  /**
   * Mark the warning delivered, so it fires once per period rather than on every
   * subsequent turn. Tracked per-mind even for a system warning: that warning goes
   * to every mind, and one mind hearing it must not silence the rest.
   */
  acknowledgeWarning(mind: string, scope: BudgetScope): void {
    if (scope === "system") {
      this.systemAck(mind).warned = true;
      return;
    }
    const state = this.budgets.get(mind);
    if (state) {
      // On the bucket, which is persisted — a mind with its own cap stays warned
      // across a daemon restart rather than being told twice.
      state.warningInjected = true;
      this.dirty.add(mind);
    }
  }

  private systemAck(mind: string): { warned: boolean; exceeded: boolean } {
    let entry = this.systemAcks.get(mind);
    if (!entry) {
      entry = { warned: false, exceeded: false };
      this.systemAcks.set(mind, entry);
    }
    return entry;
  }

  /**
   * True exactly once per budget period, when the mind first crosses a limit, so
   * callers record a single "budget exceeded" notice instead of one per turn. The
   * flag resets when the period rolls over. Per-mind for the same reason as the
   * warning: the system notice goes to every mind.
   */
  noteExceeded(mind: string, scope: BudgetScope): boolean {
    if (scope === "system") {
      if (!this.system || this.system.spentUsd < this.system.capUsd) return false;
      const entry = this.systemAck(mind);
      if (entry.exceeded) return false;
      entry.exceeded = true;
      return true;
    }
    const state = this.budgets.get(mind);
    if (!state || state.spentUsd < state.capUsd) return false;
    if (state.exceededNotified) return false;
    state.exceededNotified = true;
    this.dirty.add(mind);
    return true;
  }

  /**
   * Undo the once-per-period flag `noteExceeded` set, for a caller whose notice
   * never made it onto the record. Without this a failed insert would spend the
   * mind's one notification and leave it paused with no idea why.
   */
  retractExceeded(mind: string, scope: BudgetScope): void {
    if (scope === "system") {
      const entry = this.systemAcks.get(mind);
      if (entry) entry.exceeded = false;
      return;
    }
    const state = this.budgets.get(mind);
    if (state) {
      state.exceededNotified = false;
      this.dirty.add(mind);
    }
  }

  /**
   * Whether this mind's inbound deliveries should be held, and which bucket says so.
   * Null means deliver normally.
   *
   * This is what makes a cap a limit rather than a meter: {@link DeliveryManager}
   * consults it before every POST and leaves held rows `pending` in `delivery_queue`,
   * where its own redrive sweep picks them up once this returns null again.
   *
   * Deliberately reads the level, not the once-per-period notification flags
   * `checkBudget` consults: a mind whose exceeded notice failed to record is still
   * over its cap, and a hold that depended on a notice landing would be a cap that
   * unbinds itself on a transient DB error.
   *
   * The system bucket wins a tie for the same reason it does in `checkBudget` —
   * naming the mind's own cap when the install's is what tripped would be false.
   */
  holdFor(mind: string): { scope: BudgetScope; resetAt: number } | null {
    if (this.system && this.system.spentUsd >= this.system.capUsd) {
      return { scope: "system", resetAt: periodEnd(this.system) };
    }
    const state = this.budgets.get(mind);
    if (state && state.spentUsd >= state.capUsd) {
      return { scope: "mind", resetAt: periodEnd(state) };
    }
    return null;
  }

  getUsage(mind: string): {
    spentUsd: number;
    capUsd: number;
    periodMinutes: number;
    periodStart: number;
    resetAt: number;
    hasUnpricedTurns: boolean;
    percentUsed: number;
  } | null {
    const state = this.budgets.get(mind);
    if (!state) return null;
    return {
      spentUsd: state.spentUsd,
      capUsd: state.capUsd,
      periodMinutes: state.periodMinutes,
      periodStart: state.periodStart,
      resetAt: periodEnd(state),
      hasUnpricedTurns: state.hasUnpricedTurns,
      percentUsed: Math.round((state.spentUsd / state.capUsd) * 100),
    };
  }

  /** Install-wide spend for the current day, or null when no system cap is set. */
  getSystemUsage(): {
    spentUsd: number;
    capUsd: number;
    periodStart: number;
    resetAt: number;
    hasUnpricedTurns: boolean;
    percentUsed: number;
  } | null {
    const s = this.system;
    if (!s) return null;
    return {
      spentUsd: s.spentUsd,
      capUsd: s.capUsd,
      periodStart: s.periodStart,
      resetAt: periodEnd(s),
      hasUnpricedTurns: s.hasUnpricedTurns,
      percentUsed: Math.round((s.spentUsd / s.capUsd) * 100),
    };
  }

  /** When the given bucket next resets, as epoch millis; null when there's no such bucket. */
  resetAt(mind: string, scope: BudgetScope = "mind"): number | null {
    const state = scope === "system" ? this.system : this.budgets.get(mind);
    return state ? periodEnd(state) : null;
  }

  async tick(): Promise<void> {
    const now = Date.now();
    /** A bucket rolled over, so some mind's hold may have just ended. */
    let released = false;
    if (this.system && now - this.system.periodStart >= this.system.periodMinutes * 60_000) {
      this.resetPeriod(this.system, now);
      // A new install-wide period: every mind can be told about it again.
      this.systemAcks.clear();
      this.systemDirty = true;
      released = true;
    }
    for (const [mind, state] of this.budgets) {
      const elapsed = now - state.periodStart;
      if (elapsed >= state.periodMinutes * 60_000) {
        // Only this mind's own bucket rolls here — its system-scope acks belong to
        // the install's day and must survive, or the same system notice repeats.
        this.resetPeriod(state, now);
        this.dirty.add(mind);
        released = true;
      }
    }
    if (released) releaseHeldDeliveries();
    await this.flush();
  }

  private resetPeriod(state: BudgetState, now: number): void {
    state.spentUsd = 0;
    state.periodStart = now;
    state.warningInjected = false;
    state.exceededNotified = false;
    state.hasUnpricedTurns = false;
  }

  /** Flush all dirty budget states to disk. */
  async flush(): Promise<void> {
    const flushing = new Set(this.dirty);
    this.dirty.clear();
    const writes = [];
    for (const mind of flushing) {
      const state = this.budgets.get(mind);
      if (state)
        writes.push(
          this.saveState(this.mindStatePath(mind), state).catch(() => this.dirty.add(mind)),
        );
    }
    if (this.systemDirty && this.system) {
      this.systemDirty = false;
      writes.push(
        this.saveState(this.systemStatePath(), this.system).catch(() => {
          this.systemDirty = true;
        }),
      );
    }
    await Promise.all(writes);
  }

  private mindStatePath(mind: string): string {
    return resolve(stateDir(mind), "budget.json");
  }

  private systemStatePath(): string {
    return resolve(voluteSystemDir(), "spend.json");
  }

  private async saveState(path: string, state: BudgetState): Promise<void> {
    try {
      await mkdir(resolve(path, ".."), { recursive: true });
      const data = {
        periodStart: state.periodStart,
        spentUsd: state.spentUsd,
        hasUnpricedTurns: state.hasUnpricedTurns,
        warningInjected: state.warningInjected,
        exceededNotified: state.exceededNotified,
      };
      await writeFile(path, `${JSON.stringify(data)}\n`);
    } catch (err) {
      tlog.warn(`failed to save budget state to ${path}`, log.errorData(err));
      throw err;
    }
  }

  /**
   * Load persisted spend for the current period. A file written by the old
   * token-denominated budget carries `tokensUsed` and no `spentUsd`; it is discarded
   * rather than converted. The state is a rolling window, not history, and there is
   * no honest exchange rate from a token count to dollars after the fact.
   */
  private loadState(path: string): BudgetState | null {
    try {
      if (!existsSync(path)) return null;
      const data = JSON.parse(readFileSync(path, "utf-8"));
      if (typeof data.periodStart !== "number" || typeof data.spentUsd !== "number") return null;
      return {
        periodStart: data.periodStart,
        spentUsd: data.spentUsd,
        hasUnpricedTurns: data.hasUnpricedTurns ?? false,
        warningInjected: data.warningInjected ?? false,
        exceededNotified: data.exceededNotified ?? false,
        periodMinutes: 0, // will be overwritten by caller
        capUsd: 0, // will be overwritten by caller
      };
    } catch (err) {
      tlog.warn(`failed to load budget state from ${path}`, log.errorData(err));
      return null;
    }
  }
}

/**
 * Nudge the delivery manager to sweep now that a spend period has rolled over, rather
 * than making held messages wait out the periodic redrive interval on top of the wait
 * they already served. The rows are `pending` either way — this only changes when they
 * are noticed. Imported lazily: the delivery manager is a peer of this module, and a
 * static import in this direction would close a cycle.
 */
function releaseHeldDeliveries(): void {
  import("../delivery/delivery-manager.js")
    .then(({ tryGetDeliveryManager }) => tryGetDeliveryManager()?.redrive())
    .catch((err) => tlog.warn("failed to release held deliveries", log.errorData(err)));
}

let instance: SpendBudget | null = null;

export function initSpendBudget(): SpendBudget {
  if (instance) throw new Error("SpendBudget already initialized");
  instance = new SpendBudget();
  return instance;
}

export function getSpendBudget(): SpendBudget {
  if (!instance) throw new Error("SpendBudget not initialized — call initSpendBudget() first");
  return instance;
}
