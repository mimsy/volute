import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import {
  getISOWeekKey,
  getPeriodKey,
  getPreviousPeriodKey,
  getUtcTimeRange,
  isoWeekKeyForDateStr,
  isoWeekToDate,
  utcDateTimeStr,
} from "../packages/daemon/src/lib/util/period-keys.js";

// Node resolves the process timezone once at startup, so DST-boundary behavior
// can only be exercised by re-invoking a child process with a fixed TZ. This
// runs the period-key module under a DST-observing zone and returns stdout.
function runUnderTz(tz: string, script: string): string {
  return execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-"], {
    input: script,
    env: { ...process.env, TZ: tz },
    encoding: "utf8",
  }).trim();
}

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

    it("skips the nonexistent spring-forward hour under a DST zone", () => {
      // 2026-03-08 02:00 America/New_York does not exist (clocks jump to 3 AM).
      // The previous hour of 3 AM local must be 1 AM local — a naive
      // setHours(h-1) would produce 2 AM (or loop back to 3 AM), which is wrong.
      const out = runUnderTz(
        "America/New_York",
        `import { getPreviousPeriodKey } from "${new URL("../packages/daemon/src/lib/util/period-keys.ts", import.meta.url).pathname}";
         process.stdout.write(getPreviousPeriodKey("2026-03-08T03", "hour"));`,
      );
      assert.equal(out, "2026-03-08T01");
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

  describe("getUtcTimeRange", () => {
    // Bounds are local wall-clock converted to UTC, so assert by constructing
    // the same local Dates rather than hardcoding zone-dependent strings.
    it("hour spans exactly one hour", () => {
      const { start, end } = getUtcTimeRange("2026-03-22T14", "hour");
      const startD = new Date("2026-03-22T14:00:00");
      assert.equal(start, utcDateTimeStr(startD));
      assert.equal(end, utcDateTimeStr(new Date(startD.getTime() + 3600000)));
    });

    it("day spans local midnight to next local midnight", () => {
      const { start, end } = getUtcTimeRange("2026-03-22", "day");
      assert.equal(start, utcDateTimeStr(new Date("2026-03-22T00:00:00")));
      assert.equal(end, utcDateTimeStr(new Date("2026-03-23T00:00:00")));
    });

    it("week spans Monday to next Monday", () => {
      const { start, end } = getUtcTimeRange("2026-W12", "week");
      assert.equal(start, utcDateTimeStr(new Date(2026, 2, 16)));
      assert.equal(end, utcDateTimeStr(new Date(2026, 2, 23)));
    });

    it("month spans the 1st to the next month's 1st", () => {
      const { start, end } = getUtcTimeRange("2026-12", "month");
      assert.equal(start, utcDateTimeStr(new Date(2026, 11, 1)));
      assert.equal(end, utcDateTimeStr(new Date(2027, 0, 1)));
    });

    it("bounds are half-open and contiguous across periods", () => {
      const first = getUtcTimeRange("2026-03-22", "day");
      const second = getUtcTimeRange("2026-03-23", "day");
      assert.equal(first.end, second.start);
    });
  });
});
