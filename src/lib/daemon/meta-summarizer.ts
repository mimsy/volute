import { and, eq, gte, like, lt, sql } from "drizzle-orm";
import { aiCompleteUtility } from "../ai-service.js";
import { getDb } from "../db.js";
import log from "../logger.js";
import { getPrompt } from "../prompts.js";
import { metaSummaries, mindHistory } from "../schema.js";

const sLog = log.child("meta-summarizer");

export type Period = "hour" | "day" | "week" | "month";

const SYSTEM_MIND = "_system";

// -- Period key helpers (all UTC) --

export function getPeriodKey(date: Date, period: Period): string {
  switch (period) {
    case "hour":
      return `${date.toISOString().slice(0, 10)}T${String(date.getUTCHours()).padStart(2, "0")}`;
    case "day":
      return date.toISOString().slice(0, 10);
    case "week":
      return getISOWeekKey(date);
    case "month":
      return date.toISOString().slice(0, 7);
  }
}

function getISOWeekKey(date: Date): string {
  // ISO 8601 week number: week starts Monday, week 1 contains Jan 4
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

export function getPreviousPeriodKey(key: string, period: Period): string {
  switch (period) {
    case "hour": {
      // "2026-03-22T14" → parse, subtract 1 hour
      const d = new Date(`${key.slice(0, 10)}T${key.slice(11)}:00:00Z`);
      d.setUTCHours(d.getUTCHours() - 1);
      return getPeriodKey(d, "hour");
    }
    case "day": {
      const d = new Date(`${key}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 1);
      return getPeriodKey(d, "day");
    }
    case "week": {
      // Parse ISO week, subtract 7 days from the Monday of that week
      const d = isoWeekToDate(key);
      d.setUTCDate(d.getUTCDate() - 7);
      return getPeriodKey(d, "week");
    }
    case "month": {
      const [y, m] = key.split("-").map(Number);
      const d = new Date(Date.UTC(y, m - 2, 1)); // month - 1 (0-indexed) - 1 (previous)
      return getPeriodKey(d, "month");
    }
  }
}

/** Returns the Monday (start) of an ISO week key like "2026-W12" */
function isoWeekToDate(weekKey: string): Date {
  const [yearStr, weekStr] = weekKey.split("-W");
  const year = parseInt(yearStr, 10);
  const week = parseInt(weekStr, 10);
  // Jan 4 is always in week 1
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7; // Mon=1..Sun=7
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1 + (week - 1) * 7);
  return monday;
}

export function getTimeRange(periodKey: string, period: Period): { start: string; end: string } {
  switch (period) {
    case "hour": {
      const start = `${periodKey.slice(0, 10)} ${periodKey.slice(11)}:00:00`;
      const d = new Date(`${periodKey.slice(0, 10)}T${periodKey.slice(11)}:00:00Z`);
      d.setUTCHours(d.getUTCHours() + 1);
      const end = `${d.toISOString().slice(0, 10)} ${String(d.getUTCHours()).padStart(2, "0")}:00:00`;
      return { start, end };
    }
    case "day":
      return { start: `${periodKey} 00:00:00`, end: `${periodKey} 23:59:59` };
    case "week": {
      const monday = isoWeekToDate(periodKey);
      const sunday = new Date(monday);
      sunday.setUTCDate(monday.getUTCDate() + 6);
      return {
        start: `${monday.toISOString().slice(0, 10)} 00:00:00`,
        end: `${sunday.toISOString().slice(0, 10)} 23:59:59`,
      };
    }
    case "month": {
      const [y, m] = periodKey.split("-").map(Number);
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      return {
        start: `${periodKey}-01 00:00:00`,
        end: `${periodKey}-${String(lastDay).padStart(2, "0")} 23:59:59`,
      };
    }
  }
}

// -- Source material gathering --

async function gatherHourlySources(
  mind: string,
  periodKey: string,
): Promise<{ texts: string[]; turnCount: number; channels: string[]; tools: string[] }> {
  const db = await getDb();
  const { start, end } = getTimeRange(periodKey, "hour");

  const rows = await db
    .select({
      content: mindHistory.content,
      channel: mindHistory.channel,
      metadata: mindHistory.metadata,
    })
    .from(mindHistory)
    .where(
      and(
        eq(mindHistory.mind, mind),
        eq(mindHistory.type, "summary"),
        gte(mindHistory.created_at, start),
        lt(mindHistory.created_at, end),
      ),
    )
    .orderBy(mindHistory.created_at);

  const texts: string[] = [];
  const channels = new Set<string>();
  const tools = new Set<string>();

  for (const row of rows) {
    if (row.content) texts.push(row.content);
    if (row.channel) channels.add(row.channel);
    if (row.metadata) {
      try {
        const meta = JSON.parse(row.metadata);
        if (Array.isArray(meta.tools)) {
          for (const t of meta.tools) tools.add(t);
        }
      } catch {}
    }
  }

  return {
    texts,
    turnCount: rows.length,
    channels: [...channels],
    tools: [...tools],
  };
}

async function gatherChildSummaries(
  mind: string,
  period: Period,
  periodKey: string,
): Promise<{ texts: string[]; sourceIds: number[] }> {
  const db = await getDb();
  const childPeriod = getChildPeriod(period);
  const { start, end } = getTimeRange(periodKey, period);

  let rows: { id: number; content: string }[];
  if (period === "day") {
    rows = await db
      .select({ id: metaSummaries.id, content: metaSummaries.content })
      .from(metaSummaries)
      .where(
        and(
          eq(metaSummaries.mind, mind),
          eq(metaSummaries.period, childPeriod),
          like(metaSummaries.period_key, `${periodKey}%`),
        ),
      )
      .orderBy(metaSummaries.period_key);
  } else {
    // week and month: find daily summaries in the date range
    const startKey = start.slice(0, 10);
    const endKey = end.slice(0, 10);
    rows = await db
      .select({ id: metaSummaries.id, content: metaSummaries.content })
      .from(metaSummaries)
      .where(
        and(
          eq(metaSummaries.mind, mind),
          eq(metaSummaries.period, childPeriod),
          gte(metaSummaries.period_key, startKey),
          sql`${metaSummaries.period_key} <= ${endKey}`,
        ),
      )
      .orderBy(metaSummaries.period_key);
  }

  return {
    texts: rows.map((r) => r.content),
    sourceIds: rows.map((r) => r.id),
  };
}

function getChildPeriod(period: Period): Period {
  switch (period) {
    case "day":
      return "hour";
    case "week":
    case "month":
      return "day";
    default:
      throw new Error(`No child period for ${period}`);
  }
}

// -- Summarization --

function getScopeInstruction(mind: string): string {
  if (mind === SYSTEM_MIND) {
    return 'Write in third person, describing what the minds in the system did (e.g. "Alice explored...", "The system saw activity in..."). Reference minds by name.';
  }
  return 'Write in first person as the mind who performed the actions (e.g. "I explored...", "I worked on...").';
}

function buildDeterministicSummary(sources: string[], period: Period, periodKey: string): string {
  if (sources.length === 0) return "";
  switch (period) {
    case "hour":
      return `Activity during ${periodKey.slice(11)}:00: ${sources.join(" ")}`;
    case "day":
      return `Activity on ${periodKey}:\n\n${sources.join("\n\n")}`;
    case "week":
      return `Week ${periodKey} summary:\n\n${sources.join("\n\n")}`;
    case "month":
      return `${periodKey} summary:\n\n${sources.join("\n\n")}`;
  }
}

export async function summarizePeriod(
  mind: string,
  period: Period,
  periodKey: string,
): Promise<boolean> {
  const db = await getDb();

  // Idempotency check
  const existing = await db
    .select({ id: metaSummaries.id })
    .from(metaSummaries)
    .where(
      and(
        eq(metaSummaries.mind, mind),
        eq(metaSummaries.period, period),
        eq(metaSummaries.period_key, periodKey),
      ),
    )
    .get();
  if (existing) return false;

  // Gather source material
  let texts: string[];
  let metadata: Record<string, unknown>;

  if (period === "hour") {
    const sources = await gatherHourlySources(mind, periodKey);
    if (sources.texts.length === 0) return false;
    texts = sources.texts;
    metadata = {
      turn_count: sources.turnCount,
      channels: sources.channels,
      tools: sources.tools,
    };
  } else {
    const sources = await gatherChildSummaries(mind, period, periodKey);
    if (sources.texts.length === 0) return false;
    texts = sources.texts;
    metadata = { source_count: sources.texts.length, source_ids: sources.sourceIds };
  }

  // Generate summary
  const promptKey = `meta_summary_${period}` as const;
  const scopeInstruction = getScopeInstruction(mind);
  const systemPrompt = await getPrompt(promptKey, { scope_instruction: scopeInstruction });
  const userMessage = texts.join("\n\n---\n\n");

  let content: string;
  let deterministic: boolean;

  const aiResult = await aiCompleteUtility(systemPrompt, userMessage);
  if (aiResult) {
    content = aiResult;
    deterministic = false;
  } else {
    content = buildDeterministicSummary(texts, period, periodKey);
    deterministic = true;
  }

  (metadata as Record<string, unknown>).deterministic = deterministic;

  // Insert (with conflict safety)
  try {
    await db
      .insert(metaSummaries)
      .values({
        mind,
        period,
        period_key: periodKey,
        content,
        metadata: JSON.stringify(metadata),
      })
      .onConflictDoNothing();
  } catch (err) {
    sLog.error(
      `failed to persist ${period} summary for ${mind} (${periodKey})`,
      log.errorData(err),
    );
    return false;
  }

  sLog.info(
    `generated ${period} summary for ${mind} (${periodKey})${deterministic ? " [deterministic]" : ""}`,
  );
  return true;
}

// -- System-level summaries --

async function summarizeSystem(period: Period, periodKey: string): Promise<void> {
  const db = await getDb();

  // Check if already exists
  const existing = await db
    .select({ id: metaSummaries.id })
    .from(metaSummaries)
    .where(
      and(
        eq(metaSummaries.mind, SYSTEM_MIND),
        eq(metaSummaries.period, period),
        eq(metaSummaries.period_key, periodKey),
      ),
    )
    .get();
  if (existing) return;

  // Gather all mind summaries for this period
  const rows = await db
    .select({
      mind: metaSummaries.mind,
      content: metaSummaries.content,
    })
    .from(metaSummaries)
    .where(
      and(
        eq(metaSummaries.period, period),
        eq(metaSummaries.period_key, periodKey),
        sql`${metaSummaries.mind} != ${SYSTEM_MIND}`,
      ),
    )
    .orderBy(metaSummaries.mind);

  if (rows.length === 0) return;

  const minds = [...new Set(rows.map((r) => r.mind))];
  const texts = rows.map((r) => `[${r.mind}] ${r.content}`);

  const promptKey = `meta_summary_${period}` as const;
  const scopeInstruction = getScopeInstruction(SYSTEM_MIND);
  const systemPrompt = await getPrompt(promptKey, { scope_instruction: scopeInstruction });
  const userMessage = texts.join("\n\n---\n\n");

  let content: string;
  let deterministic: boolean;

  const aiResult = await aiCompleteUtility(systemPrompt, userMessage);
  if (aiResult) {
    content = aiResult;
    deterministic = false;
  } else {
    content = buildDeterministicSummary(texts, period, periodKey);
    deterministic = true;
  }

  try {
    await db
      .insert(metaSummaries)
      .values({
        mind: SYSTEM_MIND,
        period,
        period_key: periodKey,
        content,
        metadata: JSON.stringify({ deterministic, minds, source_count: rows.length }),
      })
      .onConflictDoNothing();
  } catch (err) {
    sLog.error(`failed to persist system ${period} summary (${periodKey})`, log.errorData(err));
  }
}

// -- Tick logic --

/** Get all minds that have turn summaries in a given time range */
async function mindsWithActivity(start: string, end: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .select({ mind: mindHistory.mind })
    .from(mindHistory)
    .where(
      and(
        eq(mindHistory.type, "summary"),
        gte(mindHistory.created_at, start),
        lt(mindHistory.created_at, end),
      ),
    )
    .groupBy(mindHistory.mind);
  return rows.map((r) => r.mind);
}

/** Get all minds that have meta-summaries for a given period and key pattern */
async function mindsWithSummaries(period: Period, keyPattern: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .select({ mind: metaSummaries.mind })
    .from(metaSummaries)
    .where(
      and(
        eq(metaSummaries.period, period),
        like(metaSummaries.period_key, keyPattern),
        sql`${metaSummaries.mind} != ${SYSTEM_MIND}`,
      ),
    )
    .groupBy(metaSummaries.mind);
  return rows.map((r) => r.mind);
}

/** Get all minds that have daily meta-summaries within a date range */
async function mindsWithDailySummariesInRange(startKey: string, endKey: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .select({ mind: metaSummaries.mind })
    .from(metaSummaries)
    .where(
      and(
        eq(metaSummaries.period, "day"),
        gte(metaSummaries.period_key, startKey),
        sql`${metaSummaries.period_key} <= ${endKey}`,
        sql`${metaSummaries.mind} != ${SYSTEM_MIND}`,
      ),
    )
    .groupBy(metaSummaries.mind);
  return rows.map((r) => r.mind);
}

async function processHour(periodKey: string): Promise<void> {
  const { start, end } = getTimeRange(periodKey, "hour");
  const minds = await mindsWithActivity(start, end);
  for (const mind of minds) {
    await summarizePeriod(mind, "hour", periodKey);
  }
  if (minds.length > 0) {
    await summarizeSystem("hour", periodKey);
  }
}

async function processDay(periodKey: string): Promise<void> {
  const minds = await mindsWithSummaries("hour", `${periodKey}%`);
  for (const mind of minds) {
    await summarizePeriod(mind, "day", periodKey);
  }
  if (minds.length > 0) {
    await summarizeSystem("day", periodKey);
  }
}

async function processWeek(periodKey: string): Promise<void> {
  const { start, end } = getTimeRange(periodKey, "week");
  const startKey = start.slice(0, 10);
  const endKey = end.slice(0, 10);
  const minds = await mindsWithDailySummariesInRange(startKey, endKey);
  for (const mind of minds) {
    await summarizePeriod(mind, "week", periodKey);
  }
  if (minds.length > 0) {
    await summarizeSystem("week", periodKey);
  }
}

async function processMonth(periodKey: string): Promise<void> {
  const minds = await mindsWithSummaries("day", `${periodKey}%`);
  for (const mind of minds) {
    await summarizePeriod(mind, "month", periodKey);
  }
  if (minds.length > 0) {
    await summarizeSystem("month", periodKey);
  }
}

async function summaryExists(mind: string, period: Period, periodKey: string): Promise<boolean> {
  const db = await getDb();
  const row = await db
    .select({ id: metaSummaries.id })
    .from(metaSummaries)
    .where(
      and(
        eq(metaSummaries.mind, mind),
        eq(metaSummaries.period, period),
        eq(metaSummaries.period_key, periodKey),
      ),
    )
    .get();
  return !!row;
}

/** Check for and fill any missing summaries going back a reasonable window */
async function backfill(): Promise<void> {
  const now = new Date();

  // Backfill hourly: last 48 hours
  for (let i = 1; i <= 48; i++) {
    const d = new Date(now);
    d.setUTCHours(d.getUTCHours() - i);
    const key = getPeriodKey(d, "hour");
    // Only process if no system summary exists (quick check to avoid re-scanning)
    if (!(await summaryExists(SYSTEM_MIND, "hour", key))) {
      await processHour(key);
    }
  }

  // Backfill daily: last 7 days
  for (let i = 1; i <= 7; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const key = getPeriodKey(d, "day");
    if (!(await summaryExists(SYSTEM_MIND, "day", key))) {
      await processDay(key);
    }
  }

  // Backfill weekly: last 4 weeks
  for (let i = 1; i <= 4; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i * 7);
    const key = getPeriodKey(d, "week");
    if (!(await summaryExists(SYSTEM_MIND, "week", key))) {
      await processWeek(key);
    }
  }

  // Backfill monthly: last 3 months
  for (let i = 1; i <= 3; i++) {
    const d = new Date(now);
    d.setUTCMonth(d.getUTCMonth() - i);
    const key = getPeriodKey(d, "month");
    if (!(await summaryExists(SYSTEM_MIND, "month", key))) {
      await processMonth(key);
    }
  }
}

// -- MetaSummarizer class --

export class MetaSummarizer {
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastHourKey: string | null = null;
  private hasBackfilled = false;

  start(): void {
    // Tick every 5 minutes
    this.interval = setInterval(() => this.tick(), 5 * 60_000);
    // Run first tick async
    this.tick();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async tick(): Promise<void> {
    try {
      // Backfill on first tick
      if (!this.hasBackfilled) {
        this.hasBackfilled = true;
        await backfill();
      }

      const now = new Date();
      const currentHourKey = getPeriodKey(now, "hour");

      // Hourly: detect boundary crossing
      if (this.lastHourKey && this.lastHourKey !== currentHourKey) {
        await processHour(this.lastHourKey);
      }
      this.lastHourKey = currentHourKey;

      // Daily: check if yesterday needs summarization
      const yesterday = new Date(now);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const yesterdayKey = getPeriodKey(yesterday, "day");
      if (!(await summaryExists(SYSTEM_MIND, "day", yesterdayKey))) {
        await processDay(yesterdayKey);
      }

      // Weekly: check if last week needs summarization (only check after Monday)
      const currentWeekKey = getPeriodKey(now, "week");
      const prevWeekKey = getPreviousPeriodKey(currentWeekKey, "week");
      if (!(await summaryExists(SYSTEM_MIND, "week", prevWeekKey))) {
        await processWeek(prevWeekKey);
      }

      // Monthly: check if last month needs summarization
      const currentMonthKey = getPeriodKey(now, "month");
      const prevMonthKey = getPreviousPeriodKey(currentMonthKey, "month");
      if (!(await summaryExists(SYSTEM_MIND, "month", prevMonthKey))) {
        await processMonth(prevMonthKey);
      }
    } catch (err) {
      sLog.error("tick failed", log.errorData(err));
    }
  }
}

let instance: MetaSummarizer | null = null;

export function initMetaSummarizer(): MetaSummarizer {
  if (instance) throw new Error("MetaSummarizer already initialized");
  instance = new MetaSummarizer();
  return instance;
}
