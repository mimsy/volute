import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  getPeriodKey,
  getPreviousPeriodKey,
  getTimeRange,
  type Period,
  summarizePeriod,
  summarizeTurn,
} from "../src/lib/daemon/summarizer.js";
import { clearMind } from "../src/lib/daemon/turn-tracker.js";
import { getDb } from "../src/lib/db.js";
import { mindHistory, summaries, turns } from "../src/lib/schema.js";

describe("summarizer", () => {
  // ── Period key helpers ──

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
      const d = new Date("2026-03-22T14:30:00Z");
      assert.equal(getPeriodKey(d, "week"), "2026-W12");
    });

    it("pads hour with leading zero", () => {
      const d = new Date("2026-03-22T03:00:00Z");
      assert.equal(getPeriodKey(d, "hour"), "2026-03-22T03");
    });

    it("pads week number with leading zero", () => {
      const d = new Date("2026-01-05T00:00:00Z");
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
      assert.equal(getPreviousPeriodKey("2026-W12", "week"), "2026-W11");
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
      assert.equal(start, "2026-03-16 00:00:00");
      assert.equal(end, "2026-03-22 23:59:59");
    });
  });

  // ── Turn summarization ──

  describe("summarizeTurn", () => {
    const mind = "test-summarizer";
    const session = "test-session";

    async function insertEvent(
      type: string,
      opts?: { content?: string; channel?: string; metadata?: Record<string, unknown> },
    ) {
      const db = await getDb();
      const result = await db
        .insert(mindHistory)
        .values({
          mind,
          type,
          session,
          channel: opts?.channel ?? null,
          content: opts?.content ?? null,
          metadata: opts?.metadata ? JSON.stringify(opts.metadata) : null,
        })
        .returning({ id: mindHistory.id });
      return result[0].id;
    }

    it("generates deterministic summary for a basic turn", async () => {
      await insertEvent("inbound", { content: "hello", channel: "@chat" });
      await insertEvent("tool_use", { metadata: { name: "Read" } });
      await insertEvent("outbound", { content: "hi there" });
      const doneId = await insertEvent("done");

      await summarizeTurn(mind, session, "@chat", doneId);

      const db = await getDb();
      const rows = await db
        .select()
        .from(summaries)
        .where(and(eq(summaries.mind, mind), eq(summaries.period, "turn")));
      const summary = rows[0];
      assert.ok(summary, "summary should be inserted");
      assert.ok(summary.content.includes("Received message"), "should mention received message");
      assert.ok(summary.content.includes("Read"), "should mention tool name");
      assert.ok(summary.content.includes("Sent response"), "should mention sent response");

      const meta = JSON.parse(summary.metadata!);
      assert.equal(meta.deterministic, true);
      assert.equal(meta.tool_count, 1);
      assert.deepEqual(meta.tools, ["Read"]);
    });

    it("skips summary for turn with no substantive output", async () => {
      const mind2 = "test-summarizer-2";
      const db = await getDb();
      const result = await db
        .insert(mindHistory)
        .values({ mind: mind2, type: "done", session: "s2" })
        .returning({ id: mindHistory.id });

      await summarizeTurn(mind2, "s2", undefined, result[0].id);

      const rows = await db
        .select()
        .from(summaries)
        .where(and(eq(summaries.mind, mind2), eq(summaries.period, "turn")));
      assert.equal(rows.length, 0, "no summary should be inserted for empty turn");
    });

    it("uses turn_id-based query when turnId is provided", async () => {
      const mind4 = "test-summarizer-turnid";
      const session4 = "s4";
      const turnId = `test-turn-${Date.now()}`;
      const db = await getDb();

      await db
        .insert(turns)
        .values({ id: turnId, mind: mind4, session: session4, status: "active" });

      await db.insert(mindHistory).values({
        mind: mind4,
        type: "inbound",
        session: session4,
        channel: "@test",
        content: "hello from turn",
        turn_id: turnId,
      });
      await db.insert(mindHistory).values({
        mind: mind4,
        type: "tool_use",
        session: session4,
        metadata: JSON.stringify({ name: "Write" }),
        turn_id: turnId,
      });
      const doneResult = await db
        .insert(mindHistory)
        .values({ mind: mind4, type: "done", session: session4, turn_id: turnId })
        .returning({ id: mindHistory.id });

      await summarizeTurn(mind4, session4, "@test", doneResult[0].id, turnId);

      const rows = await db
        .select()
        .from(summaries)
        .where(and(eq(summaries.mind, mind4), eq(summaries.period, "turn")));
      assert.equal(rows.length, 1);
      const summary = rows[0];
      assert.ok(summary.content.includes("Received message"));
      assert.ok(summary.content.includes("Write"));
      assert.equal(summary.period_key, turnId);

      // Turn should have summary_id set
      let turnRow: typeof turns.$inferSelect | undefined;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        turnRow = await db.select().from(turns).where(eq(turns.id, turnId)).get();
        if (turnRow?.summary_id != null) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(turnRow!.summary_id != null, "summary_id should be set on turn");

      await clearMind(mind4);
    });

    it("skips summarization for empty turn", async () => {
      const mind3 = "test-summarizer-empty";
      const db = await getDb();
      const result = await db
        .insert(mindHistory)
        .values({ mind: mind3, type: "done", session: "empty" })
        .returning({ id: mindHistory.id });

      await summarizeTurn(mind3, "empty", undefined, result[0].id);

      const rows = await db
        .select()
        .from(summaries)
        .where(and(eq(summaries.mind, mind3), eq(summaries.period, "turn")));
      assert.equal(rows.length, 0, "no summary should be inserted for empty turn");
    });
  });

  // ── Periodic summarization ──

  describe("summarizePeriod", () => {
    async function insertSummary(
      mind: string,
      period: Period,
      periodKey: string,
      content: string,
      createdAt?: string,
    ) {
      const db = await getDb();
      const values: Record<string, unknown> = {
        mind,
        period,
        period_key: periodKey,
        content,
        metadata: JSON.stringify({ deterministic: true }),
      };
      if (createdAt) values.created_at = createdAt;
      await db.insert(summaries).values(values as typeof summaries.$inferInsert);
    }

    it("generates hourly summary from turn summaries", async () => {
      const mind = "test-hourly-sum";
      await insertSummary(
        mind,
        "turn",
        "turn-a",
        "I read a file and responded.",
        "2026-03-22 14:05:00",
      );
      await insertSummary(mind, "turn", "turn-b", "I updated the journal.", "2026-03-22 14:30:00");

      const result = await summarizePeriod(mind, "hour", "2026-03-22T14");
      assert.equal(result, true, "should generate summary");

      const db = await getDb();
      const row = await db
        .select()
        .from(summaries)
        .where(
          and(
            eq(summaries.mind, mind),
            eq(summaries.period, "hour"),
            eq(summaries.period_key, "2026-03-22T14"),
          ),
        )
        .get();

      assert.ok(row, "hourly summary should exist");
      assert.ok(row!.content.length > 0, "should have content");
      const meta = JSON.parse(row!.metadata!);
      assert.equal(meta.source_count, 2);
      assert.equal(meta.deterministic, true);
    });

    it("is idempotent — second call returns false", async () => {
      const result = await summarizePeriod("test-hourly-sum", "hour", "2026-03-22T14");
      assert.equal(result, false, "should not generate duplicate");
    });

    it("returns false when no source material exists", async () => {
      const result = await summarizePeriod("no-activity-mind", "hour", "2026-01-01T00");
      assert.equal(result, false, "should skip empty period");
    });

    it("generates daily summary from hourly summaries", async () => {
      const mind = "test-daily-sum";
      await insertSummary(mind, "hour", "2026-03-20T09", "Morning: I worked on code.");
      await insertSummary(mind, "hour", "2026-03-20T14", "Afternoon: I reviewed PRs.");
      await insertSummary(mind, "hour", "2026-03-20T17", "Evening: I updated docs.");

      const result = await summarizePeriod(mind, "day", "2026-03-20");
      assert.equal(result, true);

      const db = await getDb();
      const row = await db
        .select()
        .from(summaries)
        .where(
          and(
            eq(summaries.mind, mind),
            eq(summaries.period, "day"),
            eq(summaries.period_key, "2026-03-20"),
          ),
        )
        .get();

      assert.ok(row, "daily summary should exist");
      const meta = JSON.parse(row!.metadata!);
      assert.equal(meta.source_count, 3);
    });

    it("generates weekly summary from daily summaries", async () => {
      const mind = "test-weekly-sum";
      await insertSummary(mind, "day", "2026-03-09", "Monday work.");
      await insertSummary(mind, "day", "2026-03-11", "Wednesday work.");
      await insertSummary(mind, "day", "2026-03-13", "Friday work.");

      const result = await summarizePeriod(mind, "week", "2026-W11");
      assert.equal(result, true);

      const db = await getDb();
      const row = await db
        .select()
        .from(summaries)
        .where(
          and(
            eq(summaries.mind, mind),
            eq(summaries.period, "week"),
            eq(summaries.period_key, "2026-W11"),
          ),
        )
        .get();

      assert.ok(row, "weekly summary should exist");
      const meta = JSON.parse(row!.metadata!);
      assert.equal(meta.source_count, 3);
    });

    it("generates monthly summary from daily summaries", async () => {
      const mind = "test-monthly-sum";
      await insertSummary(mind, "day", "2026-02-01", "First day of Feb.");
      await insertSummary(mind, "day", "2026-02-15", "Mid-Feb work.");
      await insertSummary(mind, "day", "2026-02-28", "Last day of Feb.");

      const result = await summarizePeriod(mind, "month", "2026-02");
      assert.equal(result, true);

      const db = await getDb();
      const row = await db
        .select()
        .from(summaries)
        .where(
          and(
            eq(summaries.mind, mind),
            eq(summaries.period, "month"),
            eq(summaries.period_key, "2026-02"),
          ),
        )
        .get();

      assert.ok(row, "monthly summary should exist");
      const meta = JSON.parse(row!.metadata!);
      assert.equal(meta.source_count, 3);
    });
  });
});
