import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isSessionReapable,
  type ReapableSession,
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
