/**
 * Backfill script: migrates turn summaries from mind_history to the unified
 * summaries table, then generates hour/day/week/month meta-summaries for all
 * historical activity.
 *
 * Usage: npx tsx scripts/backfill-summaries.ts
 */

import { and, eq, sql } from "drizzle-orm";
import {
  getPeriodKey,
  getTimeRange,
  SYSTEM_MIND,
  summarizePeriod,
  summarizeSystem,
  type TimerPeriod,
} from "../src/lib/daemon/summarizer.js";
import { getDb } from "../src/lib/db.js";
import { mindHistory, summaries, turns } from "../src/lib/schema.js";

async function migrateTurnSummaries() {
  const db = await getDb();

  // Get all turn summaries from mind_history that haven't been migrated yet
  const existing = await db
    .select({ period_key: summaries.period_key })
    .from(summaries)
    .where(eq(summaries.period, "turn"));
  const existingKeys = new Set(existing.map((r) => r.period_key));

  const historyRows = await db
    .select({
      id: mindHistory.id,
      mind: mindHistory.mind,
      session: mindHistory.session,
      content: mindHistory.content,
      metadata: mindHistory.metadata,
      turn_id: mindHistory.turn_id,
      created_at: mindHistory.created_at,
    })
    .from(mindHistory)
    .where(eq(mindHistory.type, "summary"))
    .orderBy(mindHistory.id);

  let migrated = 0;
  let skipped = 0;

  for (const row of historyRows) {
    const periodKey = row.turn_id ?? `${row.mind}-${row.id}`;
    if (existingKeys.has(periodKey)) {
      skipped++;
      continue;
    }

    try {
      const result = await db
        .insert(summaries)
        .values({
          mind: row.mind,
          period: "turn",
          period_key: periodKey,
          content: row.content ?? "",
          metadata: row.metadata,
          created_at: row.created_at,
        })
        .onConflictDoNothing()
        .returning({ id: summaries.id });

      // Link back to turn if we have a turn_id
      if (row.turn_id && result[0]?.id) {
        await db
          .update(turns)
          .set({ summary_id: result[0].id })
          .where(and(eq(turns.id, row.turn_id), sql`${turns.summary_id} IS NULL`));
      }

      migrated++;
    } catch (err) {
      console.error(`  failed to migrate summary for ${row.mind} (history id ${row.id}):`, err);
    }
  }

  console.log(`Turn summaries: migrated ${migrated}, skipped ${skipped} (already exist)`);
}

async function discoverPeriodKeys(period: TimerPeriod): Promise<string[]> {
  const db = await getDb();

  // Find the date range of all turn summaries
  const range = await db
    .select({
      min: sql<string>`MIN(${summaries.created_at})`,
      max: sql<string>`MAX(${summaries.created_at})`,
    })
    .from(summaries)
    .where(eq(summaries.period, "turn"))
    .get();

  if (!range?.min || !range?.max) return [];

  const start = new Date(range.min + "Z");
  const end = new Date(range.max + "Z");
  const keys = new Set<string>();

  // Walk from start to end generating period keys
  const cursor = new Date(start);
  while (cursor <= end) {
    keys.add(getPeriodKey(cursor, period));
    switch (period) {
      case "hour":
        cursor.setUTCHours(cursor.getUTCHours() + 1);
        break;
      case "day":
        cursor.setUTCDate(cursor.getUTCDate() + 1);
        break;
      case "week":
        cursor.setUTCDate(cursor.getUTCDate() + 7);
        break;
      case "month":
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
        break;
    }
  }

  return [...keys].sort();
}

async function getMindsForPeriod(period: TimerPeriod, periodKey: string): Promise<string[]> {
  const db = await getDb();

  if (period === "hour") {
    // Find minds with turn summaries in this hour's time range
    const { start, end } = getTimeRange(periodKey, "hour");
    const rows = await db
      .select({ mind: summaries.mind })
      .from(summaries)
      .where(
        and(
          eq(summaries.period, "turn"),
          sql`${summaries.created_at} >= ${start}`,
          sql`${summaries.created_at} < ${end}`,
          sql`${summaries.mind} != ${SYSTEM_MIND}`,
        ),
      )
      .groupBy(summaries.mind);
    return rows.map((r) => r.mind);
  }

  if (period === "day") {
    // Find minds with hourly summaries for this day
    const rows = await db
      .select({ mind: summaries.mind })
      .from(summaries)
      .where(
        and(
          eq(summaries.period, "hour"),
          sql`${summaries.period_key} LIKE ${periodKey + "%"}`,
          sql`${summaries.mind} != ${SYSTEM_MIND}`,
        ),
      )
      .groupBy(summaries.mind);
    return rows.map((r) => r.mind);
  }

  // Week and month: find minds with daily summaries in range
  const { start, end } = getTimeRange(periodKey, period);
  const startKey = start.slice(0, 10);
  const endKey = end.slice(0, 10);
  const rows = await db
    .select({ mind: summaries.mind })
    .from(summaries)
    .where(
      and(
        eq(summaries.period, "day"),
        sql`${summaries.period_key} >= ${startKey}`,
        sql`${summaries.period_key} <= ${endKey}`,
        sql`${summaries.mind} != ${SYSTEM_MIND}`,
      ),
    )
    .groupBy(summaries.mind);
  return rows.map((r) => r.mind);
}

async function generatePeriodSummaries(period: TimerPeriod): Promise<void> {
  const keys = await discoverPeriodKeys(period);
  console.log(`\n${period}: ${keys.length} period keys to check`);

  let generated = 0;
  for (const key of keys) {
    const minds = await getMindsForPeriod(period, key);
    if (minds.length === 0) continue;

    let anyGenerated = false;
    for (const mind of minds) {
      try {
        const created = await summarizePeriod(mind, period, key);
        if (created) {
          generated++;
          anyGenerated = true;
          process.stdout.write(`  ${period} ${key} [${mind}] ✓\n`);
        }
      } catch (err) {
        console.error(`  ${period} ${key} [${mind}] failed:`, err);
      }
    }

    // Generate system-level summary if any mind summaries were created for this period
    if (anyGenerated) {
      try {
        await summarizeSystem(period, key);
        process.stdout.write(`  ${period} ${key} [_system] ✓\n`);
      } catch (err) {
        console.error(`  ${period} ${key} [_system] failed:`, err);
      }
    }
  }

  console.log(`${period}: generated ${generated} mind summaries`);
}

async function main() {
  console.log("=== Backfill Summaries ===\n");

  // Step 1: Migrate turn summaries
  console.log("Step 1: Migrating turn summaries from mind_history → summaries...");
  await migrateTurnSummaries();

  // Step 2: Generate hour summaries (from turn summaries)
  console.log("\nStep 2: Generating hourly summaries...");
  await generatePeriodSummaries("hour");

  // Step 3: Generate day summaries (from hour summaries)
  console.log("\nStep 3: Generating daily summaries...");
  await generatePeriodSummaries("day");

  // Step 4: Generate week summaries (from day summaries)
  console.log("\nStep 4: Generating weekly summaries...");
  await generatePeriodSummaries("week");

  // Step 5: Generate month summaries (from day summaries)
  console.log("\nStep 5: Generating monthly summaries...");
  await generatePeriodSummaries("month");

  // Final stats
  const db = await getDb();
  const stats = await db
    .select({
      period: summaries.period,
      count: sql<number>`COUNT(*)`,
    })
    .from(summaries)
    .groupBy(summaries.period);

  console.log("\n=== Final Summary Counts ===");
  for (const s of stats) {
    console.log(`  ${s.period}: ${s.count}`);
  }

  console.log("\nDone!");
  process.exit(0);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
