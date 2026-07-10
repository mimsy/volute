import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SummaryRow } from "../packages/api/src/types.js";
import {
  getISOWeekKey,
  parseISOWeek,
  summaryBounds,
  wallNow,
} from "../packages/web/src/ui/lib/period-keys.js";
import { mergeOlderSummaries, nextSummaryPage } from "../packages/web/src/ui/lib/summary-paging.js";

function sum(id: number, period: SummaryRow["period"], key: string): SummaryRow {
  return { id, mind: "m", period, period_key: key, content: "", metadata: null, created_at: "" };
}

describe("web period-keys", () => {
  describe("wallNow anchors to the given timezone", () => {
    // 02:30 UTC on Mar 22 is still Mar 21 22:30 in New York (UTC-4 in DST).
    const instant = new Date("2026-03-22T02:30:00Z");

    it("resolves server-timezone calendar fields", () => {
      assert.deepEqual(wallNow("America/New_York", instant), {
        year: 2026,
        month: 3,
        day: 21,
        hour: 22,
      });
      assert.deepEqual(wallNow("UTC", instant), { year: 2026, month: 3, day: 22, hour: 2 });
    });
  });

  describe("getISOWeekKey / parseISOWeek", () => {
    it("computes and round-trips a week key", () => {
      assert.equal(getISOWeekKey(new Date(2026, 2, 21)), "2026-W12"); // Sat Mar 21
      const monday = parseISOWeek("2026-W12");
      assert.equal(monday.getDay(), 1);
      assert.equal(getISOWeekKey(monday), "2026-W12");
    });
  });

  describe("summaryBounds", () => {
    it("derives boundary keys in the server timezone", () => {
      const b = summaryBounds("America/New_York", new Date("2026-03-22T02:30:00Z"));
      assert.equal(b.todayKey, "2026-03-21");
      assert.equal(b.hourCutoff, "2026-03-21T22");
      assert.equal(b.todayHourFrom, "2026-03-21T00");
      assert.equal(b.weekCutoff, "2026-03-14");
      assert.equal(b.currentMonthKey, "2026-03");
      assert.equal(b.currentWeekKey, "2026-W12");
    });
  });

  describe("nextSummaryPage", () => {
    it("pages the month tier when months are loaded", () => {
      const months = [sum(1, "month", "2026-01"), sum(2, "month", "2026-02")];
      const weeks = [sum(3, "week", "2026-W05")];
      assert.deepEqual(nextSummaryPage(weeks, months), { tier: "month", to: "2026-01" });
    });

    it("falls back to the week tier until months exist", () => {
      const weeks = [sum(3, "week", "2026-W05"), sum(4, "week", "2026-W06")];
      assert.deepEqual(nextSummaryPage(weeks, []), { tier: "week", to: "2026-W05" });
    });

    it("returns null when nothing coarser than days is loaded", () => {
      assert.equal(nextSummaryPage([], []), null);
    });
  });

  describe("mergeOlderSummaries", () => {
    it("appends older rows, dedups the inclusive cursor row, and re-sorts", () => {
      const existing = [sum(2, "month", "2026-02"), sum(3, "month", "2026-03")];
      // to=2026-02 returned the cursor (id 2) again plus an older month.
      const fetched = [sum(1, "month", "2026-01"), sum(2, "month", "2026-02")];
      const { merged, exhausted } = mergeOlderSummaries(existing, fetched);
      assert.equal(exhausted, false);
      assert.deepEqual(
        merged.map((m) => m.period_key),
        ["2026-01", "2026-02", "2026-03"],
      );
      assert.equal(merged.length, 3, "no duplicate cursor row");
    });

    it("reports exhausted when the page adds nothing new", () => {
      const existing = [sum(1, "month", "2026-01")];
      const { merged, exhausted } = mergeOlderSummaries(existing, [sum(1, "month", "2026-01")]);
      assert.equal(exhausted, true);
      assert.equal(merged.length, 1);
    });
  });
});
