import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getISOWeekKey,
  getPeriodKey,
  getPreviousPeriodKey,
  isoWeekKeyForDateStr,
  isoWeekToDate,
} from "../packages/daemon/src/lib/util/period-keys.js";

describe("period-keys", () => {
  describe("getISOWeekKey", () => {
    it("computes a mid-year week", () => {
      // 2026-03-22 is a Sunday in ISO week 12
      assert.equal(getISOWeekKey(new Date(2026, 2, 22)), "2026-W12");
    });

    it("Jan 1 belongs to the previous year's last week when early in the week", () => {
      // 2027-01-01 is a Friday → ISO week 53 of 2026
      assert.equal(getISOWeekKey(new Date(2027, 0, 1)), "2026-W53");
    });

    it("Dec 31 belongs to next year's W01 when late in the week", () => {
      // 2025-12-31 is a Wednesday → ISO week 1 of 2026
      assert.equal(getISOWeekKey(new Date(2025, 11, 31)), "2026-W01");
    });
  });

  describe("isoWeekToDate", () => {
    it("round-trips through getISOWeekKey (Monday of the week)", () => {
      const monday = isoWeekToDate("2026-W12");
      assert.equal(monday.getDay(), 1); // Monday
      assert.equal(getISOWeekKey(monday), "2026-W12");
    });
  });

  describe("isoWeekKeyForDateStr", () => {
    it("maps a date to the week key of the week containing it", () => {
      assert.equal(isoWeekKeyForDateStr("2026-03-22"), "2026-W12");
      assert.equal(isoWeekKeyForDateStr("2026-03-16"), "2026-W12"); // Monday of W12
      assert.equal(isoWeekKeyForDateStr("2026-03-23"), "2026-W13"); // next Monday
    });

    it("maps across a month boundary correctly", () => {
      // 2026-03-01 is a Sunday → still ISO week 9 (the week that started Feb 23)
      assert.equal(isoWeekKeyForDateStr("2026-03-01"), "2026-W09");
    });

    it("returns non-date strings unchanged", () => {
      assert.equal(isoWeekKeyForDateStr("2026-W14"), "2026-W14");
      assert.equal(isoWeekKeyForDateStr("2026-03"), "2026-03");
    });

    it("produces keys that sort correctly against stored week keys", () => {
      // The whole point of the fix: a date bound must compare correctly with
      // "W"-format week keys (binary collation sorts "W" above digits).
      const bound = isoWeekKeyForDateStr("2026-06-29"); // 2026-W27
      assert.ok("2026-W14" <= bound, "current-year week should pass the <= bound");
      assert.ok(!("2026-W40" <= bound), "later week should fail the <= bound");
    });
  });

  describe("getPreviousPeriodKey (hour) is DST-safe", () => {
    it("steps back one hour normally", () => {
      assert.equal(getPreviousPeriodKey("2026-03-22T14", "hour"), "2026-03-22T13");
    });

    it("crosses a day boundary", () => {
      assert.equal(getPreviousPeriodKey("2026-03-22T00", "hour"), "2026-03-21T23");
    });
  });

  describe("getPeriodKey", () => {
    it("formats each tier", () => {
      const d = new Date(2026, 2, 22, 14, 30, 0);
      assert.equal(getPeriodKey(d, "hour"), "2026-03-22T14");
      assert.equal(getPeriodKey(d, "day"), "2026-03-22");
      assert.equal(getPeriodKey(d, "week"), "2026-W12");
      assert.equal(getPeriodKey(d, "month"), "2026-03");
    });
  });
});
