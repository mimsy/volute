import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  buildTranscript,
  getPeriodKey,
  getPreviousPeriodKey,
  getTimeRange,
  type HistoryRow,
  type Period,
  reconcileMissingSummaries,
  reconcileWedgedTurns,
  repairProvisionalSummaries,
  SYSTEM_MIND,
  summarizePeriod,
  summarizeSystem,
  summarizeTurn,
} from "../packages/daemon/src/lib/daemon/summarizer.js";
import {
  assignSession,
  clearMind,
  createTurn,
} from "../packages/daemon/src/lib/daemon/turn-tracker.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  initDeliveryManager,
  tryGetDeliveryManager,
} from "../packages/daemon/src/lib/delivery/delivery-manager.js";
import { mindHistory, summaries, turns } from "../packages/daemon/src/lib/schema.js";

describe("summarizer", () => {
  // ── Period key helpers ──

  describe("getPeriodKey", () => {
    it("returns correct hour key", () => {
      // getPeriodKey uses local time
      const d = new Date(2026, 2, 22, 14, 30, 0);
      assert.equal(getPeriodKey(d, "hour"), "2026-03-22T14");
    });

    it("returns correct day key", () => {
      const d = new Date(2026, 2, 22, 14, 30, 0);
      assert.equal(getPeriodKey(d, "day"), "2026-03-22");
    });

    it("returns correct month key", () => {
      const d = new Date(2026, 2, 22, 14, 30, 0);
      assert.equal(getPeriodKey(d, "month"), "2026-03");
    });

    it("returns correct week key", () => {
      const d = new Date(2026, 2, 22, 14, 30, 0);
      assert.equal(getPeriodKey(d, "week"), "2026-W12");
    });

    it("pads hour with leading zero", () => {
      const d = new Date(2026, 2, 22, 3, 0, 0);
      assert.equal(getPeriodKey(d, "hour"), "2026-03-22T03");
    });

    it("pads week number with leading zero", () => {
      const d = new Date(2026, 0, 5, 12, 0, 0);
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
    it("returns correct hour range (local → UTC)", () => {
      const { start, end } = getTimeRange("2026-03-22T14", "hour");
      // Period key is local time; getTimeRange converts to UTC for DB queries
      const localStart = new Date("2026-03-22T14:00:00");
      const localEnd = new Date("2026-03-22T15:00:00");
      const utcFmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);
      assert.equal(start, utcFmt(localStart));
      assert.equal(end, utcFmt(localEnd));
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

  // ── Wedged / interrupted turns (#395) ──

  describe("summarizeTurn: wedged/interrupted", () => {
    it("does not duplicate a summary when done arrives after a wedged-turn sweep", async () => {
      const mind = "test-wedged-dedupe";
      const session = "wd1";
      const turnId = randomUUID();
      const db = await getDb();
      await db.insert(turns).values({ id: turnId, mind, session, status: "active" });
      await db.insert(mindHistory).values({
        mind,
        type: "inbound",
        session,
        channel: "@c",
        content: "hi",
        turn_id: turnId,
      });
      await db.insert(mindHistory).values({
        mind,
        type: "text",
        session,
        content: "hello back",
        turn_id: turnId,
      });
      const doneResult = await db
        .insert(mindHistory)
        .values({ mind, type: "done", session, turn_id: turnId })
        .returning({ id: mindHistory.id });
      const doneId = doneResult[0].id;

      // The sweep summarizes the wedged turn under period_key = <turn uuid>.
      await summarizeTurn(mind, session, "@c", doneId, turnId);
      // Then the real `done` fires: completeTurn returned undefined, so no turnId is passed.
      // The old fallback keyed on "<mind>-<doneId>" and produced a SECOND summary.
      await summarizeTurn(mind, session, "@c", doneId, undefined);

      const rows = await db
        .select()
        .from(summaries)
        .where(and(eq(summaries.mind, mind), eq(summaries.period, "turn")));
      assert.equal(rows.length, 1, "exactly one summary should exist for the turn");
      assert.equal(rows[0].period_key, turnId, "summary must be keyed by the turn uuid");

      await clearMind(mind);
    });

    it("deletes the turn row for an interrupted turn (no substantive output)", async () => {
      const mind = "test-interrupted-delete";
      const session = "id1";
      const turnId = randomUUID();
      const db = await getDb();
      await db.insert(turns).values({ id: turnId, mind, session, status: "active" });
      const inbound = await db
        .insert(mindHistory)
        .values({
          mind,
          type: "inbound",
          session,
          channel: "@c",
          content: "you there?",
          turn_id: turnId,
        })
        .returning({ id: mindHistory.id });
      const doneResult = await db
        .insert(mindHistory)
        .values({ mind, type: "done", session, turn_id: turnId })
        .returning({ id: mindHistory.id });

      await summarizeTurn(mind, session, "@c", doneResult[0].id, turnId);

      const summaryRows = await db
        .select()
        .from(summaries)
        .where(and(eq(summaries.mind, mind), eq(summaries.period, "turn")));
      assert.equal(summaryRows.length, 0, "no summary for an output-less turn");

      const inboundRow = await db
        .select()
        .from(mindHistory)
        .where(eq(mindHistory.id, inbound[0].id))
        .get();
      assert.equal(inboundRow!.turn_id, null, "inbound should be un-tagged");

      const turnRow = await db.select().from(turns).where(eq(turns.id, turnId)).get();
      assert.equal(turnRow, undefined, "the orphaned turn row must be deleted");

      await clearMind(mind);
    });

    it("deletes an interrupted turn resolved via events' turn_id when called with turnId=undefined", async () => {
      // The #395 path: completeTurn returned undefined (a wedged-turn sweep already ran), so
      // `done` fires summarizeTurn with no explicit turnId. The id must be recovered from the
      // events' own turn_id column, then the output-less turn deleted.
      const mind = "test-interrupted-from-events";
      const session = "ie1";
      const turnId = randomUUID();
      const db = await getDb();
      await db.insert(turns).values({ id: turnId, mind, session, status: "active" });
      const inbound = await db
        .insert(mindHistory)
        .values({
          mind,
          type: "inbound",
          session,
          channel: "@c",
          content: "still there?",
          turn_id: turnId,
        })
        .returning({ id: mindHistory.id });
      const doneResult = await db
        .insert(mindHistory)
        .values({ mind, type: "done", session, turn_id: turnId })
        .returning({ id: mindHistory.id });

      // No explicit turnId — it must be resolved from the events' turn_id.
      await summarizeTurn(mind, session, "@c", doneResult[0].id, undefined);

      const summaryRows = await db
        .select()
        .from(summaries)
        .where(and(eq(summaries.mind, mind), eq(summaries.period, "turn")));
      assert.equal(summaryRows.length, 0, "no summary for an output-less turn");

      const inboundRow = await db
        .select()
        .from(mindHistory)
        .where(eq(mindHistory.id, inbound[0].id))
        .get();
      assert.equal(inboundRow!.turn_id, null, "inbound should be un-tagged");

      const turnRow = await db.select().from(turns).where(eq(turns.id, turnId)).get();
      assert.equal(turnRow, undefined, "turn resolved from events must be deleted");

      await clearMind(mind);
    });
  });

  // ── Transcript building ──

  describe("buildTranscript", () => {
    function row(id: number, type: string, content: string | null): HistoryRow {
      return { id, type, channel: null, session: null, content, metadata: null, created_at: "" };
    }

    it("includes error result content so the summary can describe the failure", () => {
      const events: HistoryRow[] = [
        row(1, "tool_use", null),
        row(2, "tool_result", "ENOENT: no such file or directory, open '/nope'"),
      ];
      const meta = new Map<number, Record<string, unknown>>([
        [1, { name: "Read" }],
        [2, { is_error: true }],
      ]);

      const transcript = buildTranscript(events, meta);
      assert.match(transcript, /\[result error\] ENOENT: no such file/);
    });

    it("labels successful results distinctly from errors", () => {
      const events: HistoryRow[] = [row(1, "tool_result", "ok, wrote 3 lines")];
      const meta = new Map<number, Record<string, unknown>>([[1, { is_error: false }]]);

      const transcript = buildTranscript(events, meta);
      assert.match(transcript, /\[result\] ok, wrote 3 lines/);
      assert.doesNotMatch(transcript, /result error/);
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
      // created_at must be UTC (matching datetime('now') format).
      // Period key "2026-03-22T14" = 2 PM local → convert to UTC for DB.
      const utcFmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);
      const turnATime = utcFmt(new Date("2026-03-22T14:05:00"));
      const turnBTime = utcFmt(new Date("2026-03-22T14:30:00"));
      await insertSummary(mind, "turn", "turn-a", "I read a file and responded.", turnATime);
      await insertSummary(mind, "turn", "turn-b", "I updated the journal.", turnBTime);

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

    it("promotes single child summary directly", async () => {
      const mind = "test-promote-sum";
      const utcFmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);
      const turnTime = utcFmt(new Date("2026-03-22T14:10:00"));
      await insertSummary(mind, "turn", "turn-solo", "I processed a single request.", turnTime);

      const result = await summarizePeriod(mind, "hour", "2026-03-22T14");
      assert.equal(result, true, "should promote single child");

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

      assert.ok(row, "promoted summary should exist");
      assert.equal(row!.content, "I processed a single request.", "content should match source");
      const meta = JSON.parse(row!.metadata!);
      assert.equal(meta.promoted, true);
      assert.equal(meta.source_count, 1);
      assert.ok(Array.isArray(meta.source_ids));
      assert.equal(meta.source_ids.length, 1);
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

  describe("reconcileMissingSummaries", () => {
    const utcFmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);

    async function countSummaries(mind: string, period: Period): Promise<number> {
      const db = await getDb();
      const rows = await db
        .select({ id: summaries.id })
        .from(summaries)
        .where(and(eq(summaries.mind, mind), eq(summaries.period, period)));
      return rows.length;
    }

    it("heals a missing hour + day summary from orphaned turn summaries", async () => {
      const mind = "reconcile-gap-mind";
      const db = await getDb();

      // Two turn summaries in the same hour yesterday, with no hour/day rollup.
      const base = new Date();
      base.setDate(base.getDate() - 1);
      base.setHours(10, 10, 0, 0);
      const hourKey = getPeriodKey(base, "hour");
      const dayKey = getPeriodKey(base, "day");

      await db.insert(summaries).values([
        {
          mind,
          period: "turn",
          period_key: `${mind}-t1`,
          content: "I read a file.",
          metadata: JSON.stringify({ deterministic: true }),
          created_at: utcFmt(base),
        },
        {
          mind,
          period: "turn",
          period_key: `${mind}-t2`,
          content: "I updated the journal.",
          metadata: JSON.stringify({ deterministic: true }),
          created_at: utcFmt(new Date(base.getTime() + 5 * 60_000)),
        },
      ]);

      // Precondition: no hour/day summary yet.
      assert.equal(await countSummaries(mind, "hour"), 0);
      assert.equal(await countSummaries(mind, "day"), 0);

      await reconcileMissingSummaries();

      const hourRow = await db
        .select()
        .from(summaries)
        .where(
          and(
            eq(summaries.mind, mind),
            eq(summaries.period, "hour"),
            eq(summaries.period_key, hourKey),
          ),
        )
        .get();
      assert.ok(hourRow, "missing hour summary should be generated");

      const dayRow = await db
        .select()
        .from(summaries)
        .where(
          and(
            eq(summaries.mind, mind),
            eq(summaries.period, "day"),
            eq(summaries.period_key, dayKey),
          ),
        )
        .get();
      assert.ok(dayRow, "missing day summary should be generated");

      // Idempotent: a second pass adds nothing.
      const hourCount = await countSummaries(mind, "hour");
      const dayCount = await countSummaries(mind, "day");
      await reconcileMissingSummaries();
      assert.equal(await countSummaries(mind, "hour"), hourCount, "no duplicate hour summaries");
      assert.equal(await countSummaries(mind, "day"), dayCount, "no duplicate day summaries");
    });

    it("heals a missing week summary from an orphaned previous-week day summary", async () => {
      const mind = "reconcile-week-mind";
      const db = await getDb();

      // The most recent day that is NOT in the current ISO week (1..7 days ago),
      // so it is inside the 7-day lookback but the week is not the in-progress one.
      const now = new Date();
      const daysSinceMonday = (now.getDay() + 6) % 7; // 0 = Monday .. 6 = Sunday
      const prevWeekSunday = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - daysSinceMonday - 1,
      );
      const dayKey = getPeriodKey(prevWeekSunday, "day");
      const weekKey = getPeriodKey(prevWeekSunday, "week");

      await db.insert(summaries).values({
        mind,
        period: "day",
        period_key: dayKey,
        content: "A full day of work.",
        metadata: JSON.stringify({ deterministic: true }),
      });

      assert.equal(await countSummaries(mind, "week"), 0);

      await reconcileMissingSummaries();

      const weekRow = await db
        .select()
        .from(summaries)
        .where(
          and(
            eq(summaries.mind, mind),
            eq(summaries.period, "week"),
            eq(summaries.period_key, weekKey),
          ),
        )
        .get();
      assert.ok(weekRow, "missing week summary should be generated");
    });

    it("heals a missing system rollup even when all per-mind summaries exist", async () => {
      const mind = "reconcile-sysgap-mind";
      const db = await getDb();

      // A per-mind hour summary already exists (with a turn in range) but the
      // `_system` rollup for that same hour is missing — a system insert that
      // failed once must still self-heal.
      const base = new Date();
      base.setDate(base.getDate() - 1);
      base.setHours(9, 15, 0, 0);
      const hourKey = getPeriodKey(base, "hour");

      await db.insert(summaries).values([
        {
          mind,
          period: "turn",
          period_key: `${mind}-sysgap-t1`,
          content: "I did some work.",
          metadata: JSON.stringify({ deterministic: true }),
          created_at: utcFmt(base),
        },
        {
          mind,
          period: "hour",
          period_key: hourKey,
          content: "An hour of work.",
          metadata: JSON.stringify({ deterministic: true }),
        },
      ]);

      const before = await db
        .select()
        .from(summaries)
        .where(
          and(
            eq(summaries.mind, SYSTEM_MIND),
            eq(summaries.period, "hour"),
            eq(summaries.period_key, hourKey),
          ),
        )
        .get();
      assert.equal(before, undefined, "system rollup should not exist yet");

      await reconcileMissingSummaries();

      const sysRow = await db
        .select()
        .from(summaries)
        .where(
          and(
            eq(summaries.mind, SYSTEM_MIND),
            eq(summaries.period, "hour"),
            eq(summaries.period_key, hourKey),
          ),
        )
        .get();
      assert.ok(sysRow, "missing system hour rollup should be healed");
    });

    it("skips the in-progress current hour and day", async () => {
      const db = await getDb();
      const now = new Date();
      const currentHourKey = getPeriodKey(now, "hour");
      const currentDayKey = getPeriodKey(now, "day");

      // Mind A: a turn summary in the current hour → its hour must NOT be summarized.
      const mindA = "reconcile-current-hour-mind";
      await db.insert(summaries).values({
        mind: mindA,
        period: "turn",
        period_key: `${mindA}-cur`,
        content: "still going.",
        metadata: JSON.stringify({ deterministic: true }),
        created_at: utcFmt(now),
      });

      // Mind B: an hour summary in today's current hour → the current day must NOT
      // be summarized (day is still in progress).
      const mindB = "reconcile-current-day-mind";
      await db.insert(summaries).values({
        mind: mindB,
        period: "hour",
        period_key: currentHourKey,
        content: "an hour today.",
        metadata: JSON.stringify({ deterministic: true }),
      });

      await reconcileMissingSummaries();

      assert.equal(
        await countSummaries(mindA, "hour"),
        0,
        "current in-progress hour must not be summarized",
      );

      const dayRow = await db
        .select()
        .from(summaries)
        .where(
          and(
            eq(summaries.mind, mindB),
            eq(summaries.period, "day"),
            eq(summaries.period_key, currentDayKey),
          ),
        )
        .get();
      assert.equal(dayRow, undefined, "current in-progress day must not be summarized");
    });

    it("leaves material older than the lookback window alone", async () => {
      const mind = "reconcile-old-mind";
      const db = await getDb();

      // A turn summary 8 days ago — outside the 7-day reconciliation window.
      const old = new Date();
      old.setDate(old.getDate() - 8);
      old.setHours(10, 0, 0, 0);

      await db.insert(summaries).values({
        mind,
        period: "turn",
        period_key: `${mind}-old`,
        content: "old work.",
        metadata: JSON.stringify({ deterministic: true }),
        created_at: utcFmt(old),
      });

      await reconcileMissingSummaries();

      assert.equal(
        await countSummaries(mind, "hour"),
        0,
        "out-of-window material must not be summarized (hour)",
      );
      assert.equal(
        await countSummaries(mind, "day"),
        0,
        "out-of-window material must not be summarized (day)",
      );
    });
  });

  // ── Provisional fallback bounding + repair (#404) ──

  describe("provisional meta-summaries", () => {
    async function insertSummary(
      mind: string,
      period: Period,
      periodKey: string,
      content: string,
      metadata?: Record<string, unknown>,
    ) {
      const db = await getDb();
      await db.insert(summaries).values({
        mind,
        period,
        period_key: periodKey,
        content,
        metadata: JSON.stringify(metadata ?? { deterministic: true }),
      });
    }

    async function getSummary(mind: string, period: Period, periodKey: string) {
      const db = await getDb();
      return db
        .select()
        .from(summaries)
        .where(
          and(
            eq(summaries.mind, mind),
            eq(summaries.period, period),
            eq(summaries.period_key, periodKey),
          ),
        )
        .get();
    }

    // Push a provisional row's last_attempt_at into the past so the retry-spacing guard lets the
    // next attempt through — the test-time stand-in for the ~1.4 days between real ticks.
    async function agePastBackoff(mind: string, period: Period, periodKey: string) {
      const db = await getDb();
      const row = await getSummary(mind, period, periodKey);
      const meta = JSON.parse(row!.metadata!);
      meta.last_attempt_at = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      await db
        .update(summaries)
        .set({ metadata: JSON.stringify(meta) })
        .where(eq(summaries.id, row!.id));
    }

    const failAi = async () => null;

    it("bounds the month deterministic fallback to an index instead of concatenating", async () => {
      const mind = "bounded-fallback-mind";
      const child = `${"lorem ipsum ".repeat(500)}Done.`; // ~6k chars each
      assert.ok(child.length > 5000);
      for (let d = 1; d <= 30; d++) {
        const key = `2026-04-${String(d).padStart(2, "0")}`;
        await insertSummary(mind, "day", key, `Day ${d}: ${child}`);
      }

      const generated = await summarizePeriod(mind, "month", "2026-04", failAi);
      assert.equal(generated, true);

      const row = await getSummary(mind, "month", "2026-04");
      assert.ok(row, "month summary should exist");
      // The bounded digest must be far smaller than even a single child's verbatim content.
      assert.ok(row!.content.length < 5000, `digest too large: ${row!.content.length}`);
      assert.match(row!.content, /AI summary pending/);
      assert.match(row!.content, /2026-04-01:/);
      const meta = JSON.parse(row!.metadata!);
      assert.equal(meta.deterministic, true);
      assert.equal(meta.attempts, 1);
    });

    it("retries a provisional row and replaces it when the AI later succeeds", async () => {
      const mind = "retry-heal-mind";
      await insertSummary(mind, "day", "2026-04-05", "Monday: I did things.");
      await insertSummary(mind, "day", "2026-04-06", "Tuesday: I did more.");

      const first = await summarizePeriod(mind, "month", "2026-04", failAi);
      assert.equal(first, true);
      const provisional = await getSummary(mind, "month", "2026-04");
      assert.equal(JSON.parse(provisional!.metadata!).deterministic, true);

      // A later tick (past the retry-spacing backoff) finds the AI healthy and heals the row.
      await agePastBackoff(mind, "month", "2026-04");
      const healed = "# April\n\nA steady, productive month.";
      const second = await summarizePeriod(mind, "month", "2026-04", async () => healed);
      assert.equal(second, true);

      const row = await getSummary(mind, "month", "2026-04");
      assert.equal(row!.content, healed);
      assert.equal(JSON.parse(row!.metadata!).deterministic, false);

      // Upsert, not duplicate insert.
      const db = await getDb();
      const all = await db
        .select()
        .from(summaries)
        .where(
          and(
            eq(summaries.mind, mind),
            eq(summaries.period, "month"),
            eq(summaries.period_key, "2026-04"),
          ),
        );
      assert.equal(all.length, 1);
    });

    it("stops retrying once the attempt budget is exhausted", async () => {
      const mind = "budget-exhausted-mind";
      await insertSummary(mind, "day", "2026-04-05", "A day.");
      await insertSummary(mind, "month", "2026-04", "old blob", {
        deterministic: true,
        attempts: 5,
      });

      const generated = await summarizePeriod(mind, "month", "2026-04", async () => "healed");
      assert.equal(generated, false, "budget-exhausted row should not be retried");

      const row = await getSummary(mind, "month", "2026-04");
      assert.equal(row!.content, "old blob", "row must be left untouched");
    });

    it("stops retrying once the retry window has elapsed", async () => {
      const mind = "window-elapsed-mind";
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      await insertSummary(mind, "day", "2026-04-05", "A day.");
      await insertSummary(mind, "month", "2026-04", "old blob", {
        deterministic: true,
        attempts: 1,
        first_attempt_at: eightDaysAgo,
      });

      const generated = await summarizePeriod(mind, "month", "2026-04", async () => "healed");
      assert.equal(generated, false, "aged-out row should not be retried");
      const row = await getSummary(mind, "month", "2026-04");
      assert.equal(row!.content, "old blob");
    });

    it("does not retry a provisional again within the backoff interval", async () => {
      const mind = "backoff-spacing-mind";
      // Two children so the period isn't promoted from a single child (which skips the fallback).
      await insertSummary(mind, "day", "2026-04-05", "A day.");
      await insertSummary(mind, "day", "2026-04-06", "Another day.");

      const first = await summarizePeriod(mind, "month", "2026-04", failAi);
      assert.equal(first, true);
      assert.equal(JSON.parse((await getSummary(mind, "month", "2026-04"))!.metadata!).attempts, 1);

      // A retry on the very next tick (well within the backoff) must be skipped — otherwise the
      // 5-minute tick cadence would burn the whole attempt budget in minutes.
      const second = await summarizePeriod(mind, "month", "2026-04", async () => "healed");
      assert.equal(second, false, "should not retry within the backoff interval");
      const row = await getSummary(mind, "month", "2026-04");
      assert.equal(JSON.parse(row!.metadata!).deterministic, true, "must stay provisional");
      assert.equal(JSON.parse(row!.metadata!).attempts, 1, "attempts must not increment");
    });

    it("spaces attempts across the window and gives up only after the budget", async () => {
      const mind = "spaced-budget-mind";
      // Two children so the period isn't promoted from a single child (which skips the fallback).
      await insertSummary(mind, "day", "2026-04-05", "A day.");
      await insertSummary(mind, "day", "2026-04-06", "Another day.");

      // First failure creates the provisional (attempts=1).
      await summarizePeriod(mind, "month", "2026-04", failAi);
      assert.equal(JSON.parse((await getSummary(mind, "month", "2026-04"))!.metadata!).attempts, 1);

      // Each subsequent attempt only lands once the backoff has elapsed, so the budget genuinely
      // spans the window rather than exhausting at tick cadence.
      for (let expected = 2; expected <= 5; expected++) {
        await agePastBackoff(mind, "month", "2026-04");
        const retried = await summarizePeriod(mind, "month", "2026-04", failAi);
        assert.equal(retried, true, `attempt ${expected} should run`);
        assert.equal(
          JSON.parse((await getSummary(mind, "month", "2026-04"))!.metadata!).attempts,
          expected,
        );
      }

      // Budget exhausted: even with the AI back and the backoff elapsed, no further retries.
      await agePastBackoff(mind, "month", "2026-04");
      const done = await summarizePeriod(mind, "month", "2026-04", async () => "healed");
      assert.equal(done, false, "should stop after the attempt budget is exhausted");
      assert.equal(
        JSON.parse((await getSummary(mind, "month", "2026-04"))!.metadata!).deterministic,
        true,
      );
    });

    it("bounds the week deterministic fallback and labels it as a week", async () => {
      const mind = "bounded-week-mind";
      const child = `${"lorem ipsum ".repeat(500)}Done.`; // ~6k chars each
      // Days 2026-03-09..13 fall inside ISO week 2026-W11.
      for (let d = 9; d <= 13; d++) {
        await insertSummary(
          mind,
          "day",
          `2026-03-${String(d).padStart(2, "0")}`,
          `Day ${d}: ${child}`,
        );
      }

      const generated = await summarizePeriod(mind, "week", "2026-W11", failAi);
      assert.equal(generated, true);

      const row = await getSummary(mind, "week", "2026-W11");
      assert.ok(row, "week summary should exist");
      assert.ok(row!.content.length < 5000, `digest too large: ${row!.content.length}`);
      assert.match(row!.content, /Week 2026-W11/, "should carry the week label");
      assert.match(row!.content, /2026-03-09:/);
      assert.match(row!.content, /AI summary pending/);
      assert.equal(JSON.parse(row!.metadata!).attempts, 1);
    });

    it("truncates an oversized child before building the _system rollup", async () => {
      const key = "2026-05-10T09";
      const huge = "x".repeat(5000);
      await insertSummary("sys-child-a", "hour", key, "short child.");
      await insertSummary("sys-child-b", "hour", key, huge);

      await summarizeSystem("hour", key, failAi);

      const row = await getSummary("_system", "hour", key);
      assert.ok(row, "_system hour summary should exist");
      // The 5000-char child must have been capped (ROLLUP_CHILD_CHARS = 2000).
      assert.ok(row!.content.length < 4500, `rollup too large: ${row!.content.length}`);
      assert.ok(!row!.content.includes(huge), "oversized child must not appear verbatim");
    });

    it("repairProvisionalSummaries heals per-mind and _system rows", async () => {
      const mind = "repair-mind";
      await insertSummary(mind, "day", "2026-06-01", "Day one.");
      await insertSummary(mind, "day", "2026-06-02", "Day two.");
      await insertSummary(mind, "month", "2026-06", "per-mind blob", { deterministic: true });
      await insertSummary("_system", "month", "2026-06", "system blob", { deterministic: true });

      await repairProvisionalSummaries(async () => "HEALED");

      const mindRow = await getSummary(mind, "month", "2026-06");
      assert.equal(mindRow!.content, "HEALED");
      assert.equal(JSON.parse(mindRow!.metadata!).deterministic, false);

      const sysRow = await getSummary("_system", "month", "2026-06");
      assert.equal(sysRow!.content, "HEALED");
      assert.equal(JSON.parse(sysRow!.metadata!).deterministic, false);
    });
  });

  describe("reconcileWedgedTurns", () => {
    it("completes a wedged turn and resets its leaked session counter", async () => {
      const mind = "reconcile-mind";
      const session = "rs1";
      const idleMs = 10 * 60_000;

      // A wedged turn: has a `done`, last event well past the idle window.
      const id = await createTurn(mind);
      assert.ok(id);
      await assignSession(mind, id!, session);
      const db = await getDb();
      for (const e of [
        { type: "text", msAgo: 30 * 60_000 },
        { type: "done", msAgo: 20 * 60_000 },
      ]) {
        await db.insert(mindHistory).values({
          mind,
          type: e.type,
          session,
          turn_id: id,
          created_at: new Date(Date.now() - e.msAgo).toISOString().slice(0, 19).replace("T", " "),
        });
      }

      // Stand up the delivery manager singleton with a leaked, idle counter for this session.
      const dm = initDeliveryManager();
      try {
        (dm as any).sessionStates.set(
          mind,
          new Map([[session, { activeCount: 2, lastDeliveredAt: 0 }]]),
        );
        assert.equal(dm.isSessionBusy(mind, session), true);
        assert.equal(tryGetDeliveryManager(), dm);

        await reconcileWedgedTurns(idleMs);

        const row = await db.select().from(turns).where(eq(turns.id, id)).get();
        assert.equal(row!.status, "complete", "wedged turn should be completed");
        assert.equal(dm.isSessionBusy(mind, session), false, "leaked counter should be reset");
      } finally {
        dm.dispose();
      }
    });
  });
});
