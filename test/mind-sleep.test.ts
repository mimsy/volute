import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveWakeAt } from "../packages/cli/src/commands/mind-sleep.js";

// Fixed reference time: local 03:00 on 2026-07-07.
const now = new Date("2026-07-07T03:00:00");

describe("resolveWakeAt", () => {
  it("resolves a duration relative to now", () => {
    const result = resolveWakeAt("2h30m", now);
    assert.equal(result, new Date(now.getTime() + 9_000_000).toISOString());
  });

  it("resolves a minutes-only duration", () => {
    const result = resolveWakeAt("45m", now);
    assert.equal(result, new Date(now.getTime() + 45 * 60_000).toISOString());
  });

  it("resolves a local HH:MM later today (next occurrence)", () => {
    const result = resolveWakeAt("07:30", now);
    assert.ok(result);
    const d = new Date(result as string);
    assert.equal(d.getHours(), 7);
    assert.equal(d.getMinutes(), 30);
    assert.equal(d.getDate(), 7); // still today
    assert.ok(d > now);
  });

  it("rolls a local HH:MM that already passed to tomorrow", () => {
    const result = resolveWakeAt("01:00", now); // 01:00 < 03:00 now
    assert.ok(result);
    const d = new Date(result as string);
    assert.equal(d.getHours(), 1);
    assert.equal(d.getDate(), 8); // tomorrow
  });

  it("accepts the previously-failing bare HH:MM example (08:00)", () => {
    const result = resolveWakeAt("08:00", now);
    assert.ok(result);
    const d = new Date(result as string);
    assert.equal(d.getHours(), 8);
    assert.ok(d > now);
  });

  it("passes through an explicit ISO timestamp", () => {
    const iso = "2026-07-08T14:00:00Z";
    assert.equal(resolveWakeAt(iso, now), new Date(iso).toISOString());
  });

  it("returns null for unparseable input", () => {
    assert.equal(resolveWakeAt("nonsense", now), null);
  });

  it("returns null for an out-of-range HH:MM", () => {
    assert.equal(resolveWakeAt("25:00", now), null);
    assert.equal(resolveWakeAt("12:99", now), null);
  });
});
