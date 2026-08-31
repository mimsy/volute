import log from "../util/logger.js";

const slog = log.child("turn-slots");

/**
 * How many turns a single mind may run at once. One by default: turns are serialized
 * within a session by the streaming input channel, but a mind whose routes map channels
 * to different sessions (or that uses `$new`) would otherwise start a fresh SDK
 * subprocess per session with nothing counting them.
 */
const DEFAULT_MIND_CONCURRENT_TURNS = 1;

/**
 * A slot older than this is treated as abandoned and ignored by the gate.
 *
 * Slots are released when a mind reports `done`, and a mind that dies mid-turn without
 * reporting is otherwise gated forever — silently deaf, which is the one failure mode
 * this gate must never produce. The TTL is deliberately far longer than any plausible
 * turn: expiring early costs a little extra concurrency, expiring never costs a mind its
 * messages, and only one of those is recoverable.
 */
const SLOT_MAX_AGE_MS = 30 * 60_000;

/**
 * Longest a direct-POST path (system events, the wake flush) will wait for a slot before
 * delivering anyway. The gate smooths load; it is not a correctness barrier, so when a
 * turn overruns this the delivery goes out rather than being dropped or parked
 * indefinitely — under the storage starvation that motivated #823 this degrades to the
 * unbounded behaviour it replaced, which is exactly the point at which a held schedule
 * would be worse than an extra turn.
 *
 * A minute rather than something turn-length, because several `deliverEvent` callers are
 * awaited inside HTTP handlers (a shared file, a variant's creation notice, a manual
 * schedule fire), and this bounds how long one of those can sit open. The common case
 * costs nothing at all: an event routed to the session the mind is already running in
 * folds into that turn and never waits.
 */
const SLOT_WAIT_TIMEOUT_MS = 60_000;

/** mind → session → epoch millis the slot was taken. */
const slots = new Map<string, Map<string, number>>();

type Waiter = {
  mind: string;
  session: string;
  resolve: (timedOut: boolean, owned: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** FIFO queue of direct-POST paths waiting for a slot. */
const waiters: Waiter[] = [];

let mindCap = DEFAULT_MIND_CONCURRENT_TURNS;
let globalCap: number | undefined;

/**
 * Install the install-wide turn limits (from `limits` in config.json). Called once at
 * daemon boot, mirroring `SpendBudget.setSystemCap`.
 */
export function setTurnLimits(limits: {
  mindConcurrentTurns?: number;
  globalConcurrentTurns?: number;
}): void {
  mindCap =
    typeof limits.mindConcurrentTurns === "number" && limits.mindConcurrentTurns > 0
      ? limits.mindConcurrentTurns
      : DEFAULT_MIND_CONCURRENT_TURNS;
  globalCap =
    typeof limits.globalConcurrentTurns === "number" && limits.globalConcurrentTurns > 0
      ? limits.globalConcurrentTurns
      : undefined;
}

/** Current limits, for `volute status` and the system API. */
export function getTurnLimits(): { mindConcurrentTurns: number; globalConcurrentTurns?: number } {
  return { mindConcurrentTurns: mindCap, globalConcurrentTurns: globalCap };
}

/** Drop slots older than {@link SLOT_MAX_AGE_MS}; see the constant for why they can exist. */
function pruneStale(now: number): void {
  for (const [mind, sessions] of slots) {
    for (const [session, since] of sessions) {
      if (now - since <= SLOT_MAX_AGE_MS) continue;
      sessions.delete(session);
      slog.warn(
        `expiring a stale turn slot for ${mind}/${session} after ` +
          `${Math.round((now - since) / 60_000)}m — the mind never reported the turn done`,
      );
    }
    if (sessions.size === 0) slots.delete(mind);
  }
}

/** Number of (mind, session) pairs currently running a turn. */
export function activeTurnCount(): number {
  pruneStale(Date.now());
  let total = 0;
  for (const [, sessions] of slots) total += sessions.size;
  return total;
}

/** Every occupied slot, longest-running first — for `volute status` and the system API. */
export function activeTurnSlots(): { mind: string; session: string; since: number }[] {
  pruneStale(Date.now());
  const out: { mind: string; session: string; since: number }[] = [];
  for (const [mind, sessions] of slots) {
    for (const [session, since] of sessions) out.push({ mind, session, since });
  }
  return out.sort((a, b) => a.since - b.since);
}

export type ConcurrencyHold = { reason: string; scope: "mind" | "system" };

/**
 * Whether a delivery to (mind, session) would start a turn we are not willing to run yet.
 *
 * Three answers, in order:
 *
 * 1. **The session is already mid-turn** → no hold. The delivery folds into the running
 *    turn through the mind's streaming input channel; it starts no second subprocess and
 *    adds no concurrency. This is also, exactly, why interrupts pass the gate without the
 *    resolver needing to know an interrupt from anything else — an interrupt is by
 *    definition aimed at the session that is already running.
 * 2. **The mind is at its own cap** → hold. Default one turn per mind.
 * 3. **The install is at the global cap** → hold. Unset = unlimited.
 *
 * Both holds are momentary: they lift on the next `done`, with no period to wait out.
 */
export function concurrencyHold(mind: string, session: string): ConcurrencyHold | null {
  const now = Date.now();
  pruneStale(now);
  const sessions = slots.get(mind);
  if (sessions?.has(session)) return null;

  const mindActive = sessions?.size ?? 0;
  if (mindActive >= mindCap) return { reason: "mind_concurrency", scope: "mind" };

  if (globalCap != null) {
    let total = 0;
    for (const [, s] of slots) total += s.size;
    if (total >= globalCap) return { reason: "turn_concurrency", scope: "system" };
  }
  return null;
}

/**
 * Mark (mind, session) as running a turn. Idempotent: a second delivery folding into a
 * running turn does not take a second slot, because it does not run a second turn.
 *
 * Returns whether THIS call created the slot — whether the caller is the one that started
 * the turn. A caller whose POST then fails must put the slot back only if it owns it:
 * releasing a slot that was already there frees a turn that is still running, and the gate
 * opens while the mind is mid-turn. That matters most under load, which is when POSTs fail
 * (the event envelope carries a 10s timeout) and is exactly when the gate is load-bearing.
 */
export function acquireTurnSlot(mind: string, session: string): boolean {
  let sessions = slots.get(mind);
  if (!sessions) {
    sessions = new Map();
    slots.set(mind, sessions);
  }
  if (sessions.has(session)) return false;
  sessions.set(session, Date.now());
  return true;
}

/**
 * Free (mind, session)'s slot and hand it to the longest-waiting direct-POST path.
 *
 * Synchronous on purpose, and called from `DeliveryManager.sessionDone`, which is itself
 * synchronous to keep the decrement from interleaving with a concurrent delivery. Omit
 * `session` to free every slot the mind holds (a stop, a crash, a sessionless `done`).
 */
export function releaseTurnSlot(mind: string, session?: string): void {
  const sessions = slots.get(mind);
  if (!sessions) return;
  if (session == null) sessions.clear();
  else sessions.delete(session);
  if (sessions.size === 0) slots.delete(mind);
  notifyWaiters();
}

/**
 * Offer the freed capacity to waiters in arrival order, so a schedule that has been
 * waiting goes before one that just fired. Each grant acquires synchronously, so the next
 * waiter in line sees the slot it took.
 */
function notifyWaiters(): void {
  for (let i = 0; i < waiters.length; ) {
    const w = waiters[i];
    if (concurrencyHold(w.mind, w.session)) {
      i++;
      continue;
    }
    const owned = acquireTurnSlot(w.mind, w.session);
    clearTimeout(w.timer);
    waiters.splice(i, 1);
    w.resolve(false, owned);
  }
}

/**
 * Take a slot for a path that POSTs to a mind directly rather than through the delivery
 * queue — system events and the wake flush. Those have no pending row to be re-offered by
 * the redrive sweep, so they wait for capacity instead of being held.
 *
 * Always returns holding the slot: on timeout (or with `wait: false`, for a forced event)
 * the delivery goes ahead and is accounted, so the turn it starts is still visible to
 * everything else asking for capacity. `timedOut` is reported so the caller can say so.
 *
 * If the POST does not land, the caller MUST release the slot — but ONLY when `owned` is
 * true. `owned: false` means the delivery folded into a turn that was already running, and
 * that turn's slot is not the caller's to give back.
 */
export function takeTurnSlot(
  mind: string,
  session: string,
  opts: { wait?: boolean; timeoutMs?: number } = {},
): Promise<{ waitedMs: number; timedOut: boolean; owned: boolean }> {
  const started = Date.now();
  if (opts.wait === false || !concurrencyHold(mind, session)) {
    return Promise.resolve({ waitedMs: 0, timedOut: false, owned: acquireTurnSlot(mind, session) });
  }

  const timeoutMs = opts.timeoutMs ?? SLOT_WAIT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const waiter: Waiter = {
      mind,
      session,
      resolve: (timedOut, owned) => resolve({ waitedMs: Date.now() - started, timedOut, owned }),
      timer: setTimeout(() => {
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) waiters.splice(idx, 1);
        // Fail open: take the slot anyway so the turn is counted, and let the caller warn.
        waiter.resolve(true, acquireTurnSlot(mind, session));
      }, timeoutMs),
    };
    waiter.timer.unref?.();
    waiters.push(waiter);
  });
}

/** Test seam: backdate every held slot, to exercise the TTL without waiting it out. */
export function ageTurnSlotsForTest(ms: number): void {
  for (const [, sessions] of slots) {
    for (const [session, since] of sessions) sessions.set(session, since - ms);
  }
}

/** Test seam: drop all slots and cancel all waiters. */
export function resetTurnSlots(): void {
  slots.clear();
  for (const w of waiters.splice(0)) {
    clearTimeout(w.timer);
    w.resolve(true, false);
  }
  mindCap = DEFAULT_MIND_CONCURRENT_TURNS;
  globalCap = undefined;
}
