import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { eq, inArray } from "drizzle-orm";
import { parseMeta } from "../packages/daemon/src/lib/chat/system-events.js";
import {
  CredentialRecovery,
  INITIAL_RETRY_MS,
  MAX_RETRY_MS,
  REASON_FAILED,
  REASON_FAILED_HOST,
  REASON_RECOVERED,
  type RecoveryDeps,
  retryDelayMs,
} from "../packages/daemon/src/lib/daemon/credential-recovery.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { systemEvents } from "../packages/daemon/src/lib/schema.js";

/** Every system event recorded for the test minds (plus the spirit alert rows). */
async function eventsFor(names: string[]) {
  const db = await getDb();
  return db.select().from(systemEvents).where(inArray(systemEvents.mind, names)).all();
}

/** Reasons recorded against one mind, in insertion order. */
async function reasonsFor(name: string): Promise<string[]> {
  const rows = await eventsFor([name]);
  return rows
    .sort((a, b) => a.id - b.id)
    .map((r) => String(parseMeta(r.meta)?.reason ?? ""))
    .filter(Boolean);
}

async function clearEvents(): Promise<void> {
  const db = await getDb();
  const rows = await db.select().from(systemEvents).all();
  if (rows.length > 0) {
    await db.delete(systemEvents).where(
      inArray(
        systemEvents.id,
        rows.map((r) => r.id),
      ),
    );
  }
}

/**
 * A recovery instance whose clock, key probe and mind lifecycle are all injected,
 * so the backoff and restart assertions never touch real timers or spawn a mind.
 */
function harness(overrides: Partial<RecoveryDeps> = {}) {
  type Scheduled = { ms: number; fn: () => void };
  const scheduled: Scheduled[] = [];
  const restarts: string[] = [];
  const running = new Set<string>();
  let key: string | undefined;
  let probes = 0;
  let probeError: Error | undefined;
  /** Optional side effect run inside the injected restart (e.g. a spawn that re-marks). */
  let onRestart: ((mind: string) => Promise<void>) | undefined;

  const deps: RecoveryDeps = {
    resolveKey: async () => {
      probes++;
      if (probeError) throw probeError;
      return key;
    },
    isRunning: async (mind) => running.has(mind),
    restart: async (mind) => {
      restarts.push(mind);
      if (onRestart) {
        await onRestart(mind);
        return;
      }
      // A real restart re-enters the spawn path, which reports the outcome back:
      // a healthy spawn calls noteCredentialHealthy. Simulate that, or the tests
      // would exercise a restart no spawn ever answers.
      await instance.noteHealthy(mind);
    },
    setTimer: (fn, ms) => {
      const handle: Scheduled = { ms, fn };
      scheduled.push(handle);
      return handle;
    },
    // Cancelling must actually drop the pending retry, or "the loop stopped"
    // assertions below would pass on a loop that is still armed.
    clearTimer: (handle) => {
      const i = scheduled.indexOf(handle as Scheduled);
      if (i >= 0) scheduled.splice(i, 1);
    },
    ...overrides,
  };

  const instance = new CredentialRecovery(deps);
  return {
    recovery: instance,
    scheduled,
    restarts,
    running,
    get probes() {
      return probes;
    },
    setKey(k: string | undefined) {
      key = k;
    },
    setProbeError(e: Error | undefined) {
      probeError = e;
    },
    set onRestart(fn: ((mind: string) => Promise<void>) | undefined) {
      onRestart = fn;
    },
    /** Fire the most recently scheduled timer, as the event loop would. */
    async fire(): Promise<void> {
      const next = scheduled.pop();
      assert.ok(next, "expected a retry to be scheduled");
      next.fn();
      // The timer callback voids an async tick; let it settle.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
  };
}

describe("retryDelayMs", () => {
  it("starts at one minute and doubles", () => {
    assert.equal(retryDelayMs(0), INITIAL_RETRY_MS);
    assert.equal(retryDelayMs(1), 2 * INITIAL_RETRY_MS);
    assert.equal(retryDelayMs(2), 4 * INITIAL_RETRY_MS);
  });

  it("caps at the maximum and never exceeds it, however long the outage runs", () => {
    assert.equal(retryDelayMs(4), MAX_RETRY_MS);
    for (const attempt of [5, 10, 50, 1000, 100_000]) {
      assert.equal(retryDelayMs(attempt), MAX_RETRY_MS, `attempt ${attempt} must be capped`);
    }
  });
});

describe("CredentialRecovery", () => {
  beforeEach(async () => {
    await clearEvents();
  });

  it("records exactly one notice per outage no matter how many times the mind spawns", async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) {
      await h.recovery.markDegraded("cr-alpha", "anthropic");
    }

    const reasons = await reasonsFor("cr-alpha");
    assert.deepEqual(
      reasons,
      [REASON_FAILED],
      "five spawns during one outage must leave one notice, not five",
    );
    assert.equal(h.recovery.get("cr-alpha")?.provider, "anthropic");
  });

  it("does not re-notify after the mind has read the first notice and respawned", async () => {
    // The undelivered-event guard stops covering once the mind drains the notice, so
    // from here only the in-memory degraded set prevents a per-spawn pileup. This is
    // the only test that pins that guard for the mind's own notice — the other dedup
    // test passes on guard 2 alone.
    const h = harness();
    await h.recovery.markDegraded("cr-alpha", "anthropic");
    const db = await getDb();
    await db
      .update(systemEvents)
      .set({ delivered_at: "2026-08-22 04:00:00" })
      .where(eq(systemEvents.mind, "cr-alpha"));

    await h.recovery.markDegraded("cr-alpha", "anthropic");

    assert.deepEqual(await reasonsFor("cr-alpha"), [REASON_FAILED]);
  });

  it("does not re-notify a mind whose previous notice is still undelivered", async () => {
    // Simulates a daemon restart mid-outage: the in-memory set is empty again, but
    // the mind never ran, so its notice is still queued.
    const first = harness();
    await first.recovery.markDegraded("cr-alpha", "anthropic");
    const second = harness();
    await second.recovery.markDegraded("cr-alpha", "anthropic");

    assert.deepEqual(await reasonsFor("cr-alpha"), [REASON_FAILED]);
  });

  it("a host alert about another mind does not suppress the spirit's own notice", async () => {
    // The spirit is itself a claude mind and goes down in the same outage. Its host
    // alert about someone else must not be mistaken for its own startup notice by
    // the undelivered-event guard.
    const { getSpiritName } = await import("../packages/daemon/src/lib/config/setup.js");
    const spirit = getSpiritName();
    const h = harness();
    await h.recovery.markDegraded("cr-alpha", "anthropic");
    await h.recovery.markDegraded(spirit, "anthropic");

    // Discriminating filter: a host alert carries `affectedMind`, the spirit's own
    // notice does not. Matching on the reason alone would count the alert about
    // cr-alpha as the spirit's notice and pass while the bug is present.
    const own = (await eventsFor([spirit])).filter((r) => {
      const meta = parseMeta(r.meta);
      return meta?.reason === REASON_FAILED && !meta?.affectedMind;
    });
    assert.equal(own.length, 1, "the spirit must get its own credential notice");
  });

  it("alerts the host, naming the mind, and does not stack alerts across daemon restarts", async () => {
    const { getSpiritName } = await import("../packages/daemon/src/lib/config/setup.js");
    const spirit = getSpiritName();

    // Separate harnesses = separate daemon lifetimes, so the in-memory degraded set
    // cannot be what dedups here. Two minds go down, the daemon restarts twice mid
    // outage, and they come back degraded each time: the host must end with one
    // unread alert per affected mind, not six.
    for (const lifetime of [harness(), harness(), harness()]) {
      await lifetime.recovery.markDegraded("cr-alpha", "anthropic");
      await lifetime.recovery.markDegraded("cr-beta", "anthropic");
    }

    const spiritRows = (await eventsFor([spirit])).filter(
      (r) => parseMeta(r.meta)?.reason === REASON_FAILED_HOST,
    );
    const affected = spiritRows.map((r) => String(parseMeta(r.meta)?.affectedMind)).sort();
    assert.deepEqual(
      affected,
      ["cr-alpha", "cr-beta"],
      `one unread alert per affected mind, got ${affected.length}`,
    );
    assert.ok(spiritRows.some((r) => String(r.body).includes("cr-alpha")));
  });

  it("arms a retry loop and keeps probing while the provider is down", async () => {
    const h = harness();
    h.setKey(undefined);
    await h.recovery.markDegraded("cr-alpha", "anthropic");

    assert.equal(h.scheduled.length, 1);
    assert.equal(h.scheduled[0].ms, INITIAL_RETRY_MS);

    await h.fire();
    assert.equal(h.probes, 1);
    assert.equal(h.restarts.length, 0, "no restart while the provider is still down");
    assert.equal(h.scheduled.length, 1, "still degraded — must re-arm");
    assert.equal(h.scheduled[0].ms, 2 * INITIAL_RETRY_MS, "backoff must widen");
  });

  it("backs off up to the cap and no further", async () => {
    const h = harness();
    h.setKey(undefined);
    await h.recovery.markDegraded("cr-alpha", "anthropic");

    const delays: number[] = [h.scheduled[0].ms];
    for (let i = 0; i < 12; i++) {
      await h.fire();
      assert.equal(h.scheduled.length, 1);
      delays.push(h.scheduled[0].ms);
    }

    assert.deepEqual(
      delays.slice(0, 5),
      [1, 2, 4, 8, 15].map((m) => m * 60_000),
    );
    for (const d of delays) assert.ok(d <= MAX_RETRY_MS, `delay ${d} exceeded the cap`);
    assert.equal(delays[delays.length - 1], MAX_RETRY_MS);
  });

  it("restarts each affected running mind exactly once when the provider recovers", async () => {
    const h = harness();
    h.setKey(undefined);
    h.running.add("cr-alpha");
    h.running.add("cr-beta");
    await h.recovery.markDegraded("cr-alpha", "anthropic");
    await h.recovery.markDegraded("cr-beta", "anthropic");

    h.setKey("sk-ant-oat01-BACK");
    await h.fire();

    assert.deepEqual(h.restarts.sort(), ["cr-alpha", "cr-beta"]);
    assert.equal(h.recovery.get("cr-alpha"), undefined, "degraded set must clear on recovery");
    assert.equal(h.recovery.get("cr-beta"), undefined, "degraded set must clear on recovery");
    assert.equal(h.scheduled.length, 0, "the retry loop must stop once nothing is degraded");

    // And a second pass issues no further restarts.
    await h.recovery.attemptRecovery();
    assert.equal(h.restarts.length, 2);
  });

  it("never starts a mind that is stopped or asleep, but still queues its notice", async () => {
    const h = harness();
    h.setKey(undefined);
    h.running.add("cr-alpha");
    await h.recovery.markDegraded("cr-alpha", "anthropic");
    await h.recovery.markDegraded("cr-asleep", "anthropic");

    h.setKey("sk-ant-oat01-BACK");
    await h.fire();

    assert.deepEqual(h.restarts, ["cr-alpha"], "a sleeping/stopped mind must not be started");
    assert.deepEqual(await reasonsFor("cr-asleep"), [REASON_FAILED, REASON_RECOVERED]);
  });

  it("gives the mind a dated recovered notice so it can account for the gap", async () => {
    const h = harness();
    h.setKey(undefined);
    h.running.add("cr-alpha");
    await h.recovery.markDegraded("cr-alpha", "anthropic");
    h.setKey("sk-ant-oat01-BACK");
    await h.fire();

    const rows = (await eventsFor(["cr-alpha"])).sort((a, b) => a.id - b.id);
    const recovered = rows.find((r) => parseMeta(r.meta)?.reason === REASON_RECOVERED);
    assert.ok(recovered, "a recovered notice must be recorded");
    assert.equal(parseMeta(recovered.meta)?.provider, "anthropic");
    assert.ok(parseMeta(recovered.meta)?.since, "the recovered notice must carry the gap start");
    assert.equal(recovered.delivery, "next-turn");
  });

  it("does not claim recovery when the restart's own spawn is still credential-less", async () => {
    // The provider drops again between the probe and the spawn. Telling the mind the
    // gap closed while it is still inside the gap is the one thing this must not do.
    const h = harness();
    h.setKey(undefined);
    h.running.add("cr-alpha");
    await h.recovery.markDegraded("cr-alpha", "anthropic");

    h.setKey("sk-ant-oat01-BACK");
    h.onRestart = async (mind) => {
      // The spawn came up credential-less again and re-marks itself.
      await h.recovery.markDegraded(mind, "anthropic");
    };
    await h.fire();

    const reasons = await reasonsFor("cr-alpha");
    assert.ok(!reasons.includes(REASON_RECOVERED), `must not claim recovery; got ${reasons}`);
    assert.ok(h.recovery.get("cr-alpha"), "the mind stays degraded");
  });

  it("a shutdown mid-recovery stops before restarting the remaining minds", async () => {
    // stop() during an in-flight recovery: the rest of the batch must not be
    // re-spawned into a daemon that is calling stopAll().
    const h = harness();
    h.setKey(undefined);
    h.running.add("cr-alpha");
    h.running.add("cr-beta");
    await h.recovery.markDegraded("cr-alpha", "anthropic");
    await h.recovery.markDegraded("cr-beta", "anthropic");

    h.setKey("sk-ant-oat01-BACK");
    h.onRestart = async () => {
      h.recovery.stop();
    };
    await h.recovery.attemptRecovery();

    assert.equal(h.restarts.length, 1, `expected the batch to halt, restarted ${h.restarts}`);
  });

  it("a failed restart leaves the mind degraded, un-notified, and still being retried", async () => {
    // MindStartupError / a health-check timeout is a real bardo failure mode. The mind
    // is now neither running nor recovered; it must not be dropped from the loop and
    // must not be handed a notice saying the outage is over.
    const h = harness();
    h.setKey(undefined);
    h.running.add("cr-alpha");
    await h.recovery.markDegraded("cr-alpha", "anthropic");

    h.setKey("sk-ant-oat01-BACK");
    h.onRestart = async () => {
      throw new Error("mind did not become ready within 30000ms");
    };
    await h.fire();

    const reasons = await reasonsFor("cr-alpha");
    assert.ok(!reasons.includes(REASON_RECOVERED), `must not claim recovery; got ${reasons}`);
    assert.ok(h.recovery.get("cr-alpha"), "the mind must stay degraded after a failed restart");
    assert.equal(h.scheduled.length, 1, "the retry loop must stay armed");
  });

  it("a failed restart of the only degraded mind does not kill the retry loop", async () => {
    const h = harness();
    h.setKey(undefined);
    h.running.add("cr-alpha");
    await h.recovery.markDegraded("cr-alpha", "anthropic");

    h.setKey("sk-ant-oat01-BACK");
    h.onRestart = async () => {
      throw new Error("boom");
    };
    await h.fire();

    // A later attempt must still be able to recover it.
    h.onRestart = undefined;
    await h.recovery.attemptRecovery();
    assert.deepEqual(h.restarts, ["cr-alpha", "cr-alpha"]);
    assert.equal(h.recovery.get("cr-alpha"), undefined, "recovered on the retry");
  });

  it("a still-credential-less respawn is a continuation, not a second outage", async () => {
    // The mind has already read its first notice, so the undelivered-event guard no
    // longer covers. A recovery attempt whose respawn comes back still broken must
    // not read as a fresh outage: no second FAILED, no second host alert, and the
    // backoff must not snap back to the initial delay on every failed attempt.
    const { getSpiritName } = await import("../packages/daemon/src/lib/config/setup.js");
    const spirit = getSpiritName();
    const h = harness();
    h.setKey(undefined);
    h.running.add("cr-alpha");
    await h.recovery.markDegraded("cr-alpha", "anthropic");
    const db = await getDb();
    await db
      .update(systemEvents)
      .set({ delivered_at: "2026-08-22 04:00:00" })
      .where(eq(systemEvents.mind, "cr-alpha"));
    for (let i = 0; i < 4; i++) await h.fire();
    const widened = h.scheduled[0].ms;
    assert.ok(widened > INITIAL_RETRY_MS, "backoff has widened");

    h.setKey("sk-ant-oat01-BACK");
    h.onRestart = async (mind) => {
      await h.recovery.markDegraded(mind, "anthropic");
    };
    await h.fire();

    assert.deepEqual(
      await reasonsFor("cr-alpha"),
      [REASON_FAILED],
      "one FAILED for one continuous outage",
    );
    const hostRows = (await eventsFor([spirit])).filter(
      (r) => parseMeta(r.meta)?.reason === REASON_FAILED_HOST,
    );
    assert.equal(hostRows.length, 1, "the host must not be re-alerted for the same outage");
    assert.ok(
      h.scheduled[0].ms > INITIAL_RETRY_MS,
      "a continuation must not reset the backoff to the initial delay",
    );
  });

  it("keeps the original outage start when a respawn is still credential-less", async () => {
    // Otherwise `since` resets to now on every failed attempt and the recovered notice
    // under-reports the very gap the mind is being asked to account for.
    const h = harness();
    h.setKey(undefined);
    h.running.add("cr-alpha");
    await h.recovery.markDegraded("cr-alpha", "anthropic");
    const original = h.recovery.get("cr-alpha")?.since;
    assert.ok(original);

    h.setKey("sk-ant-oat01-BACK");
    h.onRestart = async (mind) => {
      await h.recovery.markDegraded(mind, "anthropic");
    };
    await h.fire();

    assert.equal(
      h.recovery.get("cr-alpha")?.since?.getTime(),
      original.getTime(),
      "the outage start must survive a failed recovery attempt",
    );
  });

  it("an isRunning failure leaves the mind degraded rather than claiming recovery", async () => {
    const h = harness({
      isRunning: async () => {
        throw new Error("registry unavailable");
      },
    });
    h.setKey(undefined);
    await h.recovery.markDegraded("cr-alpha", "anthropic");

    h.setKey("sk-ant-oat01-BACK");
    await h.fire();

    assert.deepEqual(h.restarts, [], "must not start a mind whose state is unknown");
    assert.ok(!(await reasonsFor("cr-alpha")).includes(REASON_RECOVERED));
    assert.ok(h.recovery.get("cr-alpha"), "stays degraded until its state is knowable");
  });

  it("a recovery kick arriving mid-pass is not dropped", async () => {
    // noteHealthy kicks a recovery for the other degraded minds. If that kick lands
    // while a pass is already running it used to be silently discarded, stranding
    // those minds until the backoff elapsed.
    const keys = new Map<string, string | undefined>([
      ["anthropic", "sk-ant-back"],
      ["openai", undefined],
    ]);
    const h = harness({ resolveKey: async (provider) => keys.get(provider) });
    h.running.add("cr-alpha");
    h.running.add("cr-beta");
    // openai is marked FIRST so the pass visits it before anthropic — by the time it
    // comes back the outer loop is past it, and only the deferred kick can catch it.
    await h.recovery.markDegraded("cr-beta", "openai");
    await h.recovery.markDegraded("cr-alpha", "anthropic");

    h.onRestart = async (mind) => {
      // openai comes back while the anthropic restart is still in flight, and
      // something kicks recovery — that kick must survive the in-flight pass.
      keys.set("openai", "sk-openai-back");
      void h.recovery.attemptRecovery();
      await h.recovery.noteHealthy(mind);
    };
    await h.recovery.attemptRecovery();
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));

    assert.deepEqual(h.restarts.sort(), ["cr-alpha", "cr-beta"], "the deferred kick must run");
    assert.equal(h.recovery.get("cr-beta"), undefined);
  });

  it("forget() drops a deleted mind and disarms the loop", async () => {
    const h = harness();
    h.setKey(undefined);
    await h.recovery.markDegraded("cr-alpha", "anthropic");
    assert.equal(h.scheduled.length, 1);

    h.recovery.forget("cr-alpha");

    assert.equal(h.recovery.get("cr-alpha"), undefined);
    assert.equal(h.scheduled.length, 0, "a deleted mind must not keep the loop armed");
  });

  it("a newly degraded mind does not inherit another mind's widened backoff", async () => {
    const h = harness();
    h.setKey(undefined);
    await h.recovery.markDegraded("cr-alpha", "anthropic");
    for (let i = 0; i < 6; i++) await h.fire();
    assert.equal(h.scheduled[0].ms, MAX_RETRY_MS, "cr-alpha has widened to the cap");

    await h.recovery.markDegraded("cr-beta", "anthropic");
    assert.equal(h.scheduled.length, 1, "the widened retry must be replaced, not doubled");
    assert.equal(h.scheduled[0].ms, INITIAL_RETRY_MS, "probe soon for the newly degraded mind");
  });

  it("keeps retrying when the probe itself throws", async () => {
    const h = harness();
    h.setProbeError(new Error("auth server unreachable"));
    await h.recovery.markDegraded("cr-alpha", "anthropic");

    await h.fire();
    assert.equal(h.restarts.length, 0);
    assert.equal(h.scheduled.length, 1, "a throwing probe must not kill the loop");
  });

  it("clears degraded state when a mind spawns healthy, without restarting it", async () => {
    const h = harness();
    h.setKey(undefined);
    h.running.add("cr-alpha");
    await h.recovery.markDegraded("cr-alpha", "anthropic");

    await h.recovery.noteHealthy("cr-alpha");

    assert.equal(h.recovery.get("cr-alpha"), undefined);
    assert.deepEqual(h.restarts, [], "a mind that just started must not be restarted");
    assert.deepEqual(await reasonsFor("cr-alpha"), [REASON_FAILED, REASON_RECOVERED]);
    assert.equal(h.scheduled.length, 0, "loop stops once nothing is degraded");
  });

  it("noteHealthy on one mind kicks recovery for the others", async () => {
    const h = harness();
    h.setKey(undefined);
    h.running.add("cr-beta");
    await h.recovery.markDegraded("cr-alpha", "anthropic");
    await h.recovery.markDegraded("cr-beta", "anthropic");

    h.setKey("sk-ant-oat01-BACK");
    await h.recovery.noteHealthy("cr-alpha");
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(h.restarts, ["cr-beta"]);
    assert.equal(h.recovery.get("cr-beta"), undefined);
  });

  it("noteHealthy is a no-op for a mind that was never degraded", async () => {
    const h = harness();
    await h.recovery.noteHealthy("cr-alpha");
    assert.deepEqual(await reasonsFor("cr-alpha"), []);
    assert.equal(h.restarts.length, 0);
  });

  it("stop() leaves no armed retry and no further recovery", async () => {
    const h = harness();
    h.setKey(undefined);
    h.running.add("cr-alpha");
    await h.recovery.markDegraded("cr-alpha", "anthropic");
    assert.equal(h.scheduled.length, 1);

    h.recovery.stop();
    assert.equal(h.scheduled.length, 0, "the pending retry must actually be cancelled");

    // And a recovery attempt after shutdown must not restart anything — otherwise it
    // races stopAll() and re-spawns a mind the daemon is trying to shut down.
    h.setKey("sk-ant-oat01-BACK");
    await h.recovery.attemptRecovery();
    assert.deepEqual(h.restarts, []);
  });
});

describe("CredentialRecovery isolation", () => {
  it("only recovers the provider that came back", async () => {
    await clearEvents();
    const h = harness({
      resolveKey: async (provider) => (provider === "anthropic" ? "sk-ant-back" : undefined),
    });
    h.running.add("cr-alpha");
    h.running.add("cr-beta");
    await h.recovery.markDegraded("cr-alpha", "anthropic");
    await h.recovery.markDegraded("cr-beta", "openai");

    await h.recovery.attemptRecovery();

    assert.deepEqual(h.restarts, ["cr-alpha"]);
    assert.equal(h.recovery.get("cr-alpha"), undefined, "the recovered mind is cleared");
    assert.ok(h.recovery.get("cr-beta"), "the still-broken provider's mind stays degraded");
  });
});
