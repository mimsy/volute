import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HistoryMessage } from "@volute/api";
import {
  isRecentInbound,
  isTurnStale,
  PENDING_INBOUND_EXPIRY_MS,
  PENDING_INBOUND_MAX_AGE_MS,
  pruneExpiredInbounds,
  RECONNECT_BACKOFF_MS,
  reconnectDelay,
  STALE_TURN_IDLE_MS,
} from "../packages/web/src/ui/lib/timeline-liveness";

function inbound(createdAt: string, id = 1): HistoryMessage {
  return {
    id,
    mind: "test",
    channel: "",
    session: null,
    sender: null,
    message_id: null,
    type: "inbound",
    content: "hi",
    metadata: null,
    turn_id: null,
    created_at: createdAt,
  };
}

// A UTC timestamp without a Z suffix, as the DB stores them.
function agoNoZ(ms: number, now: number): string {
  return new Date(now - ms).toISOString().replace("Z", "");
}

describe("reconnectDelay", () => {
  it("follows the backoff sequence and caps at the last value", () => {
    assert.equal(reconnectDelay(0), 1000);
    assert.equal(reconnectDelay(1), 2000);
    assert.equal(reconnectDelay(2), 5000);
    assert.equal(reconnectDelay(3), 10000);
    // Caps rather than growing or indexing out of bounds.
    assert.equal(reconnectDelay(4), 10000);
    assert.equal(reconnectDelay(99), 10000);
    assert.equal(reconnectDelay(RECONNECT_BACKOFF_MS.length), 10000);
  });

  it("clamps negative attempts to the first delay", () => {
    assert.equal(reconnectDelay(-1), 1000);
  });
});

describe("isRecentInbound", () => {
  const now = Date.UTC(2026, 6, 9, 12, 0, 0);

  it("accepts an inbound within the age cutoff", () => {
    assert.equal(isRecentInbound(agoNoZ(30_000, now), now), true);
    assert.equal(isRecentInbound(agoNoZ(PENDING_INBOUND_MAX_AGE_MS - 1, now), now), true);
  });

  it("rejects an inbound older than the age cutoff (phantom 'just now' guard)", () => {
    assert.equal(isRecentInbound(agoNoZ(PENDING_INBOUND_MAX_AGE_MS + 1, now), now), false);
    assert.equal(isRecentInbound(agoNoZ(60 * 60_000, now), now), false);
  });

  it("normalizes DB timestamps that lack a Z suffix", () => {
    // Same instant with and without Z must classify identically.
    const withZ = new Date(now - 30_000).toISOString();
    const withoutZ = withZ.replace("Z", "");
    assert.equal(isRecentInbound(withZ, now), isRecentInbound(withoutZ, now));
  });

  it("rejects an unparseable timestamp", () => {
    assert.equal(isRecentInbound("not-a-date", now), false);
  });
});

describe("pruneExpiredInbounds", () => {
  const now = Date.UTC(2026, 6, 9, 12, 0, 0);

  it("keeps fresh inbounds and drops expired ones", () => {
    const fresh = inbound(agoNoZ(60_000, now), 1);
    const expired = inbound(agoNoZ(PENDING_INBOUND_EXPIRY_MS + 1, now), 2);
    const result = pruneExpiredInbounds([fresh, expired], now);
    assert.deepEqual(
      result.map((e) => e.id),
      [1],
    );
  });

  it("returns everything when nothing has expired", () => {
    const items = [inbound(agoNoZ(1000, now), 1), inbound(agoNoZ(2000, now), 2)];
    assert.equal(pruneExpiredInbounds(items, now).length, 2);
  });

  it("keeps un-parseable timestamps rather than silently dropping them", () => {
    const bad = inbound("garbage", 9);
    assert.equal(pruneExpiredInbounds([bad], now).length, 1);
  });
});

describe("isTurnStale", () => {
  const now = Date.UTC(2026, 6, 9, 12, 0, 0);

  it("is false for a turn that emitted recently", () => {
    assert.equal(isTurnStale(now - 60_000, now), false);
    assert.equal(isTurnStale(now - (STALE_TURN_IDLE_MS - 1), now), false);
  });

  it("is true once idle beyond the wedged-turn threshold", () => {
    assert.equal(isTurnStale(now - STALE_TURN_IDLE_MS, now), true);
    assert.equal(isTurnStale(now - (STALE_TURN_IDLE_MS + 60_000), now), true);
  });
});
