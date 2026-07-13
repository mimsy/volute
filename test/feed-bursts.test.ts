import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BURST_GAP_MS, splitIntoBursts } from "../packages/daemon/src/lib/events/feed.js";

const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

let idCounter = 1;

/** Build a message-like row `minutes` after the base instant. */
function row(conversationId: string, minutes: number) {
  const d = new Date(BASE + minutes * 60_000);
  return {
    id: idCounter++,
    conversation_id: conversationId,
    created_at: d.toISOString().replace("T", " ").slice(0, 19),
  };
}

describe("splitIntoBursts", () => {
  it("returns no bursts for an empty input", () => {
    assert.deepEqual(splitIntoBursts([]), []);
  });

  it("groups a single message into one burst", () => {
    const rows = [row("c1", 0)];
    const bursts = splitIntoBursts(rows);
    assert.equal(bursts.length, 1);
    assert.equal(bursts[0].conversationId, "c1");
    assert.equal(bursts[0].messageCount, 1);
    assert.equal(bursts[0].startedAt, rows[0].created_at);
    assert.equal(bursts[0].endedAt, rows[0].created_at);
  });

  it("keeps messages 44 minutes apart in one burst", () => {
    const bursts = splitIntoBursts([row("c1", 0), row("c1", 44)]);
    assert.equal(bursts.length, 1);
    assert.equal(bursts[0].messageCount, 2);
  });

  it("splits messages 46 minutes apart into two bursts", () => {
    const bursts = splitIntoBursts([row("c1", 0), row("c1", 46)]);
    assert.equal(bursts.length, 2);
    assert.equal(bursts[0].messageCount, 1);
    assert.equal(bursts[1].messageCount, 1);
  });

  it("keeps messages exactly at the gap boundary in one burst (> gapMs splits)", () => {
    const bursts = splitIntoBursts([row("c1", 0), row("c1", BURST_GAP_MS / 60_000)]);
    assert.equal(bursts.length, 1);
    assert.equal(bursts[0].messageCount, 2);
  });

  it("measures gaps between consecutive messages, not from the burst start", () => {
    // 0, 30, 60, 90 — each 30 min apart, all one burst though span is 90 min.
    const bursts = splitIntoBursts([row("c1", 0), row("c1", 30), row("c1", 60), row("c1", 90)]);
    assert.equal(bursts.length, 1);
    assert.equal(bursts[0].messageCount, 4);
    assert.equal(bursts[0].startedAt.endsWith("00:00:00"), true);
  });

  it("groups per conversation even when rows interleave in time", () => {
    // Interleaved arrival order, but each conversation's rows are ascending by id.
    const c1a = row("c1", 0);
    const c2a = row("c2", 5);
    const c1b = row("c1", 10);
    const c2b = row("c2", 15);
    const bursts = splitIntoBursts([c1a, c2a, c1b, c2b]);
    assert.equal(bursts.length, 2);
    const byConv = new Map(bursts.map((b) => [b.conversationId, b]));
    assert.equal(byConv.get("c1")!.messageCount, 2);
    assert.equal(byConv.get("c2")!.messageCount, 2);
  });

  it("splits a single conversation into multiple bursts and tracks bounds", () => {
    const rows = [
      row("c1", 0),
      row("c1", 10),
      row("c1", 100), // gap of 90 min from previous → new burst
      row("c1", 110),
    ];
    const bursts = splitIntoBursts(rows);
    assert.equal(bursts.length, 2);
    assert.equal(bursts[0].messageCount, 2);
    assert.equal(bursts[0].startedAt, rows[0].created_at);
    assert.equal(bursts[0].endedAt, rows[1].created_at);
    assert.equal(bursts[1].messageCount, 2);
    assert.equal(bursts[1].startedAt, rows[2].created_at);
    assert.equal(bursts[1].endedAt, rows[3].created_at);
  });
});
