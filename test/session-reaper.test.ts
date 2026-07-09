import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isSessionReapable,
  type ReapableQuery,
  type ReapableSession,
  reapSessionQuery,
  reapSessionsForShutdown,
  type ShutdownReapable,
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
