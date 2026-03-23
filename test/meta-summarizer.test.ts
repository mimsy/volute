import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  getPeriodKey,
  getPreviousPeriodKey,
  getTimeRange,
  type Period,
  summarizePeriod,
} from "../src/lib/daemon/meta-summarizer.js";
import { getDb } from "../src/lib/db.js";
import { metaSummaries, mindHistory } from "../src/lib/schema.js";

describe("meta-summarizer", () => {
  describe("getPeriodKey", () => {
    it("returns correct hour key", () => {
      const d = new Date("2026-03-22T14:30:00Z");
      assert.equal(getPeriodKey(d, "hour"), "2026-03-22T14");
    });

    it("returns correct day key", () => {
      const d = new Date("2026-03-22T14:30:00Z");
      assert.equal(getPeriodKey(d, "day"), "2026-03-22");
    });

    it("returns correct month key", () => {
      const d = new Date("2026-03-22T14:30:00Z");
      assert.equal(getPeriodKey(d, "month"), "2026-03");
    });

    it("returns correct week key", () => {
      // 2026-03-22 is a Sunday → ISO week 12 (Mon 2026-03-16 to Sun 2026-03-22)
      const d = new Date("2026-03-22T14:30:00Z");
      assert.equal(getPeriodKey(d, "week"), "2026-W12");
    });

    it("pads hour with leading zero", () => {
      const d = new Date("2026-03-22T03:00:00Z");
      assert.equal(getPeriodKey(d, "hour"), "2026-03-22T03");
    });

    it("pads week number with leading zero", () => {
      const d = new Date("2026-01-05T00:00:00Z"); // Week 2
      assert.equal(getPeriodKey(d, "week"), "2026-W02");
    });
  });

  describe("getPreviousPeriodKey", () => {
    it("returns previous hour", () => {
      assert.equal(getPreviousPeriodKey("2026-03-22T14", "hour"), "2026-03-22T13");
    });

    it("handles hour crossing midnight", () => {
      assert.equal(getPreviousPeriodKey("2026-03-22T00", "hour"), "2026-03-21T23");
    });

    it("returns previous day", () => {
      assert.equal(getPreviousPeriodKey("2026-03-22", "day"), "2026-03-21");
    });

    it("handles day crossing month boundary", () => {
      assert.equal(getPreviousPeriodKey("2026-03-01", "day"), "2026-02-28");
    });

    it("returns previous month", () => {
      assert.equal(getPreviousPeriodKey("2026-03", "month"), "2026-02");
    });

    it("handles month crossing year boundary", () => {
      assert.equal(getPreviousPeriodKey("2026-01", "month"), "2025-12");
    });

    it("returns previous week", () => {
      const prev = getPreviousPeriodKey("2026-W12", "week");
      assert.equal(prev, "2026-W11");
    });
  });

  describe("getTimeRange", () => {
    it("returns correct hour range", () => {
      const { start, end } = getTimeRange("2026-03-22T14", "hour");
      assert.equal(start, "2026-03-22 14:00:00");
      assert.equal(end, "2026-03-22 15:00:00");
    });

    it("returns correct day range", () => {
      const { start, end } = getTimeRange("2026-03-22", "day");
      assert.equal(start, "2026-03-22 00:00:00");
      assert.equal(end, "2026-03-22 23:59:59");
    });

    it("returns correct month range", () => {
      const { start, end } = getTimeRange("2026-03", "month");
      assert.equal(start, "2026-03-01 00:00:00");
      assert.equal(end, "2026-03-31 23:59:59");
    });

    it("handles February correctly", () => {
      const { end } = getTimeRange("2026-02", "month");
      assert.equal(end, "2026-02-28 23:59:59");
    });

    it("returns correct week range", () => {
      const { start, end } = getTimeRange("2026-W12", "week");
      // Week 12 of 2026: Mon Mar 16 to Sun Mar 22
      assert.equal(start, "2026-03-16 00:00:00");
      assert.equal(end, "2026-03-22 23:59:59");
    });
  });

  describe("summarizePeriod", () => {
    const mind = "test-meta-sum";

    async function insertTurnSummary(content: string, createdAt: string, channel?: string) {
      const db = await getDb();
      await db.insert(mindHistory).values({
        mind,
        type: "summary",
        session: "test",
        channel: channel ?? "@chat",
        content,
        metadata: JSON.stringify({
          deterministic: true,
          tools: ["Read"],
          from_time: createdAt,
          to_time: createdAt,
        }),
        created_at: createdAt,
      });
    }

    async function insertMetaSummary(
      summaryMind: string,
      period: Period,
      periodKey: string,
      content: string,
    ) {
      const db = await getDb();
      await db.insert(metaSummaries).values({
        mind: summaryMind,
        period,
        period_key: periodKey,
        content,
        metadata: JSON.stringify({ deterministic: true }),
      });
    }

    it("generates hourly summary from turn summaries", async () => {
      // Insert turn summaries within 14:00-15:00 on 2026-03-22
      await insertTurnSummary("I read a file and responded.", "2026-03-22 14:05:00");
      await insertTurnSummary("I updated the journal.", "2026-03-22 14:30:00");

      const result = await summarizePeriod(mind, "hour", "2026-03-22T14");
      assert.equal(result, true, "should generate summary");

      const db = await getDb();
      const row = await db
        .select()
        .from(metaSummaries)
        .where(
          and(
            eq(metaSummaries.mind, mind),
            eq(metaSummaries.period, "hour"),
            eq(metaSummaries.period_key, "2026-03-22T14"),
          ),
        )
        .get();

      assert.ok(row, "meta_summary row should exist");
      assert.ok(row!.content.length > 0, "should have content");
      const meta = JSON.parse(row!.metadata!);
      assert.equal(meta.turn_count, 2);
      assert.equal(meta.deterministic, true);
    });

    it("is idempotent — second call returns false", async () => {
      // The previous test already created this summary
      const result = await summarizePeriod(mind, "hour", "2026-03-22T14");
      assert.equal(result, false, "should not generate duplicate");
    });

    it("returns false when no source material exists", async () => {
      const result = await summarizePeriod("no-activity-mind", "hour", "2026-01-01T00");
      assert.equal(result, false, "should skip empty period");

      const db = await getDb();
      const row = await db
        .select()
        .from(metaSummaries)
        .where(
          and(
            eq(metaSummaries.mind, "no-activity-mind"),
            eq(metaSummaries.period, "hour"),
            eq(metaSummaries.period_key, "2026-01-01T00"),
          ),
        )
        .get();
      assert.equal(row, undefined, "no row should be created");
    });

    it("generates daily summary from hourly summaries", async () => {
      const dailyMind = "test-meta-daily";

      // Insert hourly summaries for a day
      await insertMetaSummary(dailyMind, "hour", "2026-03-20T09", "Morning: I worked on code.");
      await insertMetaSummary(dailyMind, "hour", "2026-03-20T14", "Afternoon: I reviewed PRs.");
      await insertMetaSummary(dailyMind, "hour", "2026-03-20T17", "Evening: I updated docs.");

      const result = await summarizePeriod(dailyMind, "day", "2026-03-20");
      assert.equal(result, true);

      const db = await getDb();
      const row = await db
        .select()
        .from(metaSummaries)
        .where(
          and(
            eq(metaSummaries.mind, dailyMind),
            eq(metaSummaries.period, "day"),
            eq(metaSummaries.period_key, "2026-03-20"),
          ),
        )
        .get();

      assert.ok(row, "daily summary should exist");
      assert.ok(row!.content.length > 0);
      const meta = JSON.parse(row!.metadata!);
      assert.equal(meta.source_count, 3);
      assert.equal(meta.deterministic, true);
    });

    it("generates weekly summary from daily summaries", async () => {
      const weeklyMind = "test-meta-weekly";

      // Week 11 of 2026: Mon Mar 9 to Sun Mar 15
      await insertMetaSummary(weeklyMind, "day", "2026-03-09", "Monday work.");
      await insertMetaSummary(weeklyMind, "day", "2026-03-11", "Wednesday work.");
      await insertMetaSummary(weeklyMind, "day", "2026-03-13", "Friday work.");

      const result = await summarizePeriod(weeklyMind, "week", "2026-W11");
      assert.equal(result, true);

      const db = await getDb();
      const row = await db
        .select()
        .from(metaSummaries)
        .where(
          and(
            eq(metaSummaries.mind, weeklyMind),
            eq(metaSummaries.period, "week"),
            eq(metaSummaries.period_key, "2026-W11"),
          ),
        )
        .get();

      assert.ok(row, "weekly summary should exist");
      const meta = JSON.parse(row!.metadata!);
      assert.equal(meta.source_count, 3);
    });

    it("generates monthly summary from daily summaries", async () => {
      const monthlyMind = "test-meta-monthly";

      await insertMetaSummary(monthlyMind, "day", "2026-02-01", "First day of Feb.");
      await insertMetaSummary(monthlyMind, "day", "2026-02-15", "Mid-Feb work.");
      await insertMetaSummary(monthlyMind, "day", "2026-02-28", "Last day of Feb.");

      const result = await summarizePeriod(monthlyMind, "month", "2026-02");
      assert.equal(result, true);

      const db = await getDb();
      const row = await db
        .select()
        .from(metaSummaries)
        .where(
          and(
            eq(metaSummaries.mind, monthlyMind),
            eq(metaSummaries.period, "month"),
            eq(metaSummaries.period_key, "2026-02"),
          ),
        )
        .get();

      assert.ok(row, "monthly summary should exist");
      const meta = JSON.parse(row!.metadata!);
      assert.equal(meta.source_count, 3);
    });
  });
});
