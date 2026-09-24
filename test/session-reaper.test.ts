import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createActivityClock,
  interruptCurrentTurn,
  isSessionReapable,
  type ReapableQuery,
  type ReapableSession,
  reapSessionQuery,
  reapSessionsForShutdown,
  reapTimeoutMs,
  type ShutdownReapable,
  shouldColdReset,
} from "../templates/claude/src/lib/session-reaper.js";

const TIMEOUT = 30 * 60_000; // 30 min
const NOW = 1_000_000_000;

function session(overrides: Partial<ReapableSession> & { empty?: boolean } = {}): ReapableSession {
  const { empty = true, ...rest } = overrides;
  return {
    name: "main",
    lastActivityAt: NOW - TIMEOUT - 1, // idle past the timeout by default
    currentMessageId: undefined,
    channel: { isEmpty: () => empty },
    ...rest,
  };
}

const notCompacting = () => false;

describe("isSessionReapable", () => {
  it("reaps a session idle past the timeout", () => {
    assert.equal(isSessionReapable(session(), NOW, TIMEOUT, notCompacting), true);
  });

  it("does not reap when activity is recent (timer reset)", () => {
    const s = session({ lastActivityAt: NOW - 60_000 }); // active 1 min ago
    assert.equal(isSessionReapable(s, NOW, TIMEOUT, notCompacting), false);
  });

  it("does not reap exactly at the boundary (strictly greater required)", () => {
    const s = session({ lastActivityAt: NOW - TIMEOUT });
    assert.equal(isSessionReapable(s, NOW, TIMEOUT, notCompacting), false);
  });

  it("does not reap a session mid-turn", () => {
    const s = session({ currentMessageId: "m1" });
    assert.equal(isSessionReapable(s, NOW, TIMEOUT, notCompacting), false);
  });

  it("does not reap a session with queued/in-flight input", () => {
    const s = session({ empty: false });
    assert.equal(isSessionReapable(s, NOW, TIMEOUT, notCompacting), false);
  });

  it("does not reap a session mid-compaction", () => {
    assert.equal(
      isSessionReapable(session(), NOW, TIMEOUT, () => true),
      false,
    );
  });

  it("never reaps when reaping is disabled (timeout 0)", () => {
    const s = session({ lastActivityAt: 0 }); // ancient
    assert.equal(isSessionReapable(s, NOW, 0, notCompacting), false);
  });
});

describe("reapSessionQuery", () => {
  it("awaits query.return() so the subprocess exit is reaped (not fire-and-forget)", async () => {
    let returned = false;
    let resolveReturn: () => void = () => {};
    const query: ReapableQuery = {
      return() {
        return new Promise<void>((resolve) => {
          resolveReturn = () => {
            returned = true;
            resolve();
          };
        });
      },
    };

    let done = false;
    const p = reapSessionQuery(query, () => {}).then(() => {
      done = true;
    });

    // return() is still pending, so reapSessionQuery must not have resolved yet.
    await Promise.resolve();
    assert.equal(done, false);
    assert.equal(returned, false);

    resolveReturn();
    await p;
    assert.equal(done, true);
    assert.equal(returned, true);
  });

  it("no-ops when there is no query", async () => {
    let errored = false;
    await reapSessionQuery(undefined, () => {
      errored = true;
    });
    assert.equal(errored, false);
  });

  it("reports errors via onError without throwing", async () => {
    const boom = new Error("teardown failed");
    let captured: unknown;
    await reapSessionQuery(
      {
        return() {
          return Promise.reject(boom);
        },
      },
      (err) => {
        captured = err;
      },
    );
    assert.equal(captured, boom);
  });
});

describe("reapSessionsForShutdown", () => {
  function fakeSession(name: string): ShutdownReapable & {
    closed: boolean;
    returned: boolean;
  } {
    const s = {
      name,
      closed: false,
      returned: false,
      channel: {
        close() {
          s.closed = true;
        },
      },
      currentQuery: {
        return() {
          s.returned = true;
          return Promise.resolve();
        },
      } as ReapableQuery,
    };
    return s;
  }

  it("closes and reaps every live session (not just idle ones)", async () => {
    const a = fakeSession("main");
    const b = fakeSession("side");
    await reapSessionsForShutdown([a, b], () => {});
    assert.equal(a.closed, true);
    assert.equal(a.returned, true);
    assert.equal(b.closed, true);
    assert.equal(b.returned, true);
  });

  it("still closes a session that has no live query", async () => {
    const s: ShutdownReapable & { closed: boolean } = {
      name: "main",
      closed: false,
      channel: {
        close() {
          s.closed = true;
        },
      },
      currentQuery: undefined,
    };
    await reapSessionsForShutdown([s], () => {});
    assert.equal(s.closed, true);
  });

  it("one wedged/failed reap doesn't block the others; errors go to onError", async () => {
    const boom = new Error("stuck child");
    const good = fakeSession("good");
    const bad: ShutdownReapable & { closed: boolean } = {
      name: "bad",
      closed: false,
      channel: {
        close() {
          bad.closed = true;
        },
      },
      currentQuery: {
        return() {
          return Promise.reject(boom);
        },
      } as ReapableQuery,
    };
    const errors: [string, unknown][] = [];
    await reapSessionsForShutdown([bad, good], (name, err) => errors.push([name, err]));
    // The good session was reaped despite the bad one failing.
    assert.equal(good.returned, true);
    assert.equal(bad.closed, true);
    assert.deepEqual(errors, [["bad", boom]]);
  });

  it("no-ops on an empty session set", async () => {
    await assert.doesNotReject(() => reapSessionsForShutdown([], () => {}));
  });
});

describe("shouldColdReset", () => {
  const COLD = 55 * 60_000;
  const record = (lastActivityAt?: number, committed = true) => ({ committed, lastActivityAt });

  it("fires at the threshold and not a millisecond before", () => {
    assert.equal(shouldColdReset("main", record(NOW - COLD), NOW, COLD, 10_000), true);
    assert.equal(shouldColdReset("main", record(NOW - COLD + 1), NOW, COLD, 10_000), false);
  });

  it("never resets when seeding is off — there'd be no seed to reset into", () => {
    assert.equal(shouldColdReset("main", record(NOW - 10 * COLD), NOW, COLD, 0), false);
  });

  it("never resets an ephemeral new-* session", () => {
    assert.equal(shouldColdReset("new-abc", record(NOW - 10 * COLD), NOW, COLD, 10_000), false);
  });

  it("is disabled by 0, and skips pointers with no turn or no recorded last turn", () => {
    assert.equal(shouldColdReset("main", record(NOW - 10 * COLD), NOW, 0, 10_000), false);
    assert.equal(shouldColdReset("main", record(NOW - 10 * COLD, false), NOW, COLD, 10_000), false);
    assert.equal(shouldColdReset("main", record(undefined), NOW, COLD, 10_000), false);
    assert.equal(shouldColdReset("main", undefined, NOW, COLD, 10_000), false);
  });
});

describe("reapTimeoutMs", () => {
  it("reaps by the sooner threshold, but never when reaping is off", () => {
    assert.equal(reapTimeoutMs(30, 55), 30);
    assert.equal(reapTimeoutMs(90, 55), 55);
    // Reaping off stays off: a live session is never reaped, cold threshold or not.
    assert.equal(reapTimeoutMs(0, 55), 0);
    assert.equal(reapTimeoutMs(30, 0), 30);
    assert.equal(reapTimeoutMs(0, 0), 0);
  });
});

describe("createActivityClock", () => {
  it("keeps a long turn's pointer fresh, so a restart mid-turn is not a quiet stretch", () => {
    const COLD = 55 * 60_000;
    let persisted: number | undefined;
    const clock = createActivityClock(
      (at) => {
        persisted = at;
      },
      () => {},
    );
    const turnStart = NOW;
    // A 70-minute tool loop: stream activity every 30s, no turn end yet.
    for (let t = turnStart; t <= turnStart + 70 * 60_000; t += 30_000) clock.touch(t);
    const restartAt = turnStart + 70 * 60_000;
    assert.ok(persisted !== undefined && restartAt - persisted <= 60_000);
    const record = { committed: true, lastActivityAt: persisted };
    assert.equal(shouldColdReset("main", record, restartAt, COLD, 10_000), false);
  });

  it("throttles writes but never a forced one (turn end)", () => {
    const writes: number[] = [];
    const clock = createActivityClock((at) => writes.push(at), assert.fail, 60_000);
    clock.touch(0);
    clock.touch(10_000);
    clock.touch(59_999);
    clock.touch(60_000);
    clock.touch(61_000, true);
    assert.deepEqual(writes, [0, 60_000, 61_000]);
  });
});

describe("interruptCurrentTurn", () => {
  it("is a no-op while the query is cleared between streams (a rotation's fetch)", () => {
    const s = { currentMessageId: "m1", currentQuery: undefined };
    assert.equal(
      interruptCurrentTurn(s, () => assert.fail("no error expected")),
      false,
    );
  });

  it("catches a rejection from a dead query instead of leaving it unhandled", async () => {
    const errors: unknown[] = [];
    const s = {
      currentMessageId: "m1",
      currentQuery: { interrupt: () => Promise.reject(new Error("query closed")) },
    };
    assert.equal(
      interruptCurrentTurn(s, (e) => errors.push(e)),
      true,
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(errors.length, 1);
  });

  it("does nothing between turns", () => {
    let called = false;
    const s = {
      currentMessageId: undefined,
      currentQuery: {
        interrupt: async () => {
          called = true;
        },
      },
    };
    assert.equal(
      interruptCurrentTurn(s, () => {}),
      false,
    );
    assert.equal(called, false);
  });
});

describe("createActivityClock — a failed write", () => {
  it("is reported, never thrown, and retried on the next touch", () => {
    const errors: unknown[] = [];
    let fail = true;
    const writes: number[] = [];
    const clock = createActivityClock(
      (at) => {
        if (fail) throw new Error("EACCES");
        writes.push(at);
      },
      (e) => errors.push(e),
    );
    assert.doesNotThrow(() => clock.touch(0, true));
    assert.equal(errors.length, 1);
    fail = false;
    clock.touch(1000); // within the throttle, but the last write never landed
    assert.deepEqual(writes, [1000]);
  });
});
