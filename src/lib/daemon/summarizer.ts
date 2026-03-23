import { and, desc, eq, gte, like, lt, sql } from "drizzle-orm";
import { aiCompleteUtility } from "../ai-service.js";
import { getDb } from "../db.js";
import { publish as publishMindEvent } from "../events/mind-events.js";
import { summarizeTool } from "../format-tool.js";
import log from "../logger.js";
import { getPrompt } from "../prompts.js";
import { messages, mindHistory, summaries, turns } from "../schema.js";

const sLog = log.child("summarizer");

/** Periods that participate in timer-driven periodic summarization */
export type TimerPeriod = "hour" | "day" | "week" | "month";

/** All summary periods including event-driven turn summaries */
export type Period = "turn" | TimerPeriod;

const SYSTEM_MIND = "_system";

// ── Period key helpers (all UTC) ──

export function getPeriodKey(date: Date, period: TimerPeriod): string {
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
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

export function getPreviousPeriodKey(key: string, period: TimerPeriod): string {
  switch (period) {
    case "hour": {
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
      const d = isoWeekToDate(key);
      d.setUTCDate(d.getUTCDate() - 7);
      return getPeriodKey(d, "week");
    }
    case "month": {
      const [y, m] = key.split("-").map(Number);
      const d = new Date(Date.UTC(y, m - 2, 1));
      return getPeriodKey(d, "month");
    }
  }
}

function isoWeekToDate(weekKey: string): Date {
  const [yearStr, weekStr] = weekKey.split("-W");
  const year = parseInt(yearStr, 10);
  const week = parseInt(weekStr, 10);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1 + (week - 1) * 7);
  return monday;
}

export function getTimeRange(
  periodKey: string,
  period: TimerPeriod,
): { start: string; end: string } {
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

// ── Turn summarization (event-driven) ──

type HistoryRow = {
  id: number;
  type: string;
  channel: string | null;
  session: string | null;
  content: string | null;
  metadata: string | null;
  created_at: string;
};

async function gatherTurnEvents(
  mind: string,
  session: string | undefined,
  doneId: number,
): Promise<{ events: HistoryRow[]; fromId: number; toId: number }> {
  const db = await getDb();

  const conditions = [
    eq(mindHistory.mind, mind),
    eq(mindHistory.type, "done"),
    lt(mindHistory.id, doneId),
  ];
  if (session) {
    conditions.push(eq(mindHistory.session, session));
  }

  const prevDone = await db
    .select({ id: mindHistory.id })
    .from(mindHistory)
    .where(and(...conditions))
    .orderBy(desc(mindHistory.id))
    .limit(1);

  const prevDoneId = prevDone.length > 0 ? prevDone[0].id : 0;

  const turnConditions = [
    eq(mindHistory.mind, mind),
    sql`${mindHistory.id} > ${prevDoneId}`,
    sql`${mindHistory.id} <= ${doneId}`,
  ];
  if (session) {
    turnConditions.push(eq(mindHistory.session, session));
  }

  const events = await db
    .select({
      id: mindHistory.id,
      type: mindHistory.type,
      channel: mindHistory.channel,
      session: mindHistory.session,
      content: mindHistory.content,
      metadata: mindHistory.metadata,
      created_at: mindHistory.created_at,
    })
    .from(mindHistory)
    .where(and(...turnConditions))
    .orderBy(mindHistory.id);

  return {
    events,
    fromId: events.length > 0 ? events[0].id : doneId,
    toId: doneId,
  };
}

async function gatherTurnEventsByTurnId(
  turnId: string,
): Promise<{ events: HistoryRow[]; fromId: number; toId: number }> {
  const db = await getDb();
  const events = await db
    .select({
      id: mindHistory.id,
      type: mindHistory.type,
      channel: mindHistory.channel,
      session: mindHistory.session,
      content: mindHistory.content,
      metadata: mindHistory.metadata,
      created_at: mindHistory.created_at,
    })
    .from(mindHistory)
    .where(eq(mindHistory.turn_id, turnId))
    .orderBy(mindHistory.id);

  return {
    events,
    fromId: events.length > 0 ? events[0].id : 0,
    toId: events.length > 0 ? events[events.length - 1].id : 0,
  };
}

function buildTurnDeterministicSummary(events: HistoryRow[]): string {
  const channels = new Set<string>();
  const tools: string[] = [];
  let hasInbound = false;
  let hasOutbound = false;

  for (const ev of events) {
    if (ev.type === "inbound") {
      hasInbound = true;
      if (ev.channel) channels.add(ev.channel);
    }
    if (ev.type === "outbound" || ev.type === "text") {
      hasOutbound = true;
    }
    if (ev.type === "tool_use" && ev.metadata) {
      try {
        const meta = JSON.parse(ev.metadata);
        if (meta.name) tools.push(meta.name);
      } catch (err) {
        sLog.debug(`failed to parse tool_use metadata for event ${ev.id}`, log.errorData(err));
      }
    }
  }

  const parts: string[] = [];
  if (hasInbound) {
    const channelList = [...channels];
    parts.push(
      channelList.length > 0 ? `Received message on ${channelList.join(", ")}` : "Received message",
    );
  }
  if (tools.length > 0) {
    const unique = [...new Set(tools)];
    parts.push(`Used ${unique.join(", ")}`);
  }
  if (hasOutbound) {
    parts.push("Sent response");
  }

  return parts.length > 0 ? `${parts.join(". ")}.` : "Turn completed.";
}

function buildTranscript(events: HistoryRow[]): string {
  const lines: string[] = [];
  for (const ev of events) {
    switch (ev.type) {
      case "inbound":
        lines.push(`[inbound${ev.channel ? ` ${ev.channel}` : ""}] ${ev.content ?? ""}`);
        break;
      case "outbound":
      case "text":
        lines.push(`[response] ${(ev.content ?? "").slice(0, 500)}`);
        break;
      case "tool_use": {
        let toolInfo = "tool";
        if (ev.metadata) {
          try {
            const meta = JSON.parse(ev.metadata);
            toolInfo = summarizeTool(meta.name ?? "tool", meta.input ?? {});
          } catch (err) {
            sLog.debug(`failed to parse tool_use metadata for event ${ev.id}`, log.errorData(err));
          }
        }
        lines.push(toolInfo);
        break;
      }
      case "tool_result": {
        const content = ev.content ?? "";
        let isError = false;
        if (ev.metadata) {
          try {
            const meta = JSON.parse(ev.metadata);
            isError = !!meta.is_error;
          } catch (err) {
            sLog.debug(
              `failed to parse tool_result metadata for event ${ev.id}`,
              log.errorData(err),
            );
          }
        }
        lines.push(isError ? "[result error]" : `[result] ${content.slice(0, 200)}`);
        break;
      }
      case "thinking":
        lines.push(`[thinking] ${(ev.content ?? "").slice(0, 300)}`);
        break;
    }
  }
  return lines.join("\n");
}

export async function summarizeTurn(
  mind: string,
  session: string | undefined,
  channel: string | undefined,
  doneId: number,
  turnId?: string,
): Promise<void> {
  const { events, fromId, toId } = turnId
    ? await gatherTurnEventsByTurnId(turnId)
    : await gatherTurnEvents(mind, session, doneId);

  if (events.length === 0) return;

  // Detect interrupted turns
  const substantiveTypes = new Set(["text", "outbound", "tool_use", "tool_result", "thinking"]);
  const hasSubstantiveOutput = events.some((ev) => substantiveTypes.has(ev.type));
  if (!hasSubstantiveOutput) {
    sLog.info(
      `skipping summary for interrupted turn ${turnId ?? "(no turn)"} (no substantive output)`,
    );
    if (turnId) {
      try {
        const db = await getDb();
        await db
          .update(mindHistory)
          .set({ turn_id: null })
          .where(and(eq(mindHistory.turn_id, turnId), eq(mindHistory.type, "inbound")));
        await db.update(messages).set({ turn_id: null }).where(eq(messages.turn_id, turnId));
      } catch (err) {
        sLog.error(`failed to un-tag events for interrupted turn ${turnId}`, log.errorData(err));
      }
    }
    return;
  }

  const tools: string[] = [];
  for (const ev of events) {
    if (ev.type === "tool_use" && ev.metadata) {
      try {
        const meta = JSON.parse(ev.metadata);
        if (meta.name) tools.push(meta.name);
      } catch (err) {
        sLog.debug(`failed to parse tool_use metadata for event ${ev.id}`, log.errorData(err));
      }
    }
  }

  const fromTime = events[0].created_at;
  const toTime = events[events.length - 1].created_at;

  let summaryText: string;
  let deterministic: boolean;

  const transcript = buildTranscript(events);
  if (transcript.trim()) {
    const summaryPrompt = await getPrompt("turn_summary");
    const aiResult = await aiCompleteUtility(summaryPrompt, transcript);
    if (aiResult) {
      summaryText = aiResult;
      deterministic = false;
    } else {
      summaryText = buildTurnDeterministicSummary(events);
      deterministic = true;
    }
  } else {
    summaryText = buildTurnDeterministicSummary(events);
    deterministic = true;
  }

  const metadata = {
    deterministic,
    tool_count: tools.length,
    tools: [...new Set(tools)],
    from_id: fromId,
    to_id: toId,
    from_time: fromTime,
    to_time: toTime,
  };

  // Write to unified summaries table
  const periodKey = turnId ?? `${mind}-${doneId}`;
  const db = await getDb();
  let summaryId: number | undefined;
  try {
    const result = await db
      .insert(summaries)
      .values({
        mind,
        period: "turn",
        period_key: periodKey,
        content: summaryText,
        metadata: JSON.stringify(metadata),
      })
      .onConflictDoNothing()
      .returning({ id: summaries.id });
    summaryId = result[0]?.id;

    // If conflict (duplicate), look up existing row for linking
    if (summaryId == null) {
      const existing = await db
        .select({ id: summaries.id })
        .from(summaries)
        .where(
          and(
            eq(summaries.mind, mind),
            eq(summaries.period, "turn"),
            eq(summaries.period_key, periodKey),
          ),
        )
        .get();
      summaryId = existing?.id;
    }
  } catch (err) {
    sLog.error(
      `failed to persist turn summary for ${mind} (events ${fromId}-${toId})`,
      log.errorData(err),
    );
    return;
  }

  // Link summary back to turn
  if (turnId && summaryId != null) {
    setSummaryId(turnId, summaryId).catch((err) => {
      sLog.error(`failed to link summary to turn ${turnId}`, log.errorData(err));
    });
  }

  // Publish to SSE
  publishMindEvent(mind, {
    mind,
    type: "summary",
    session,
    channel,
    content: summaryText,
    metadata,
    turnId,
  });
}

/** Update a turn's summary_id. */
async function setSummaryId(turnId: string, summaryId: number): Promise<void> {
  try {
    const db = await getDb();
    await db.update(turns).set({ summary_id: summaryId }).where(eq(turns.id, turnId));
  } catch (err) {
    sLog.error(`failed to set summary_id for turn ${turnId}`, log.errorData(err));
  }
}

// ── Periodic summarization (timer-driven) ──

function getChildPeriod(period: TimerPeriod): Period {
  switch (period) {
    case "hour":
      return "turn";
    case "day":
      return "hour";
    case "week":
    case "month":
      return "day";
  }
}

function getScopeInstruction(mind: string): string {
  if (mind === SYSTEM_MIND) {
    return 'Write in third person, describing what the minds in the system did (e.g. "Alice explored...", "The system saw activity in..."). Reference minds by name.';
  }
  return 'Write in first person as the mind who performed the actions (e.g. "I explored...", "I worked on...").';
}

function buildPeriodicDeterministicSummary(
  sources: string[],
  period: TimerPeriod,
  periodKey: string,
): string {
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

async function gatherChildSummaries(
  mind: string,
  period: TimerPeriod,
  periodKey: string,
): Promise<{ texts: string[]; sourceIds: number[] }> {
  const db = await getDb();
  const childPeriod = getChildPeriod(period);

  if (period === "hour") {
    // Hour reads turn summaries; turn period_keys aren't date-based,
    // so we filter by created_at time range instead
    const { start, end } = getTimeRange(periodKey, "hour");
    const rows = await db
      .select({ id: summaries.id, content: summaries.content })
      .from(summaries)
      .where(
        and(
          eq(summaries.mind, mind),
          eq(summaries.period, childPeriod),
          gte(summaries.created_at, start),
          lt(summaries.created_at, end),
        ),
      )
      .orderBy(summaries.created_at);
    return {
      texts: rows.map((r) => r.content),
      sourceIds: rows.map((r) => r.id),
    };
  }

  if (period === "day") {
    // Day reads hourly summaries whose period_key starts with the day
    const rows = await db
      .select({ id: summaries.id, content: summaries.content })
      .from(summaries)
      .where(
        and(
          eq(summaries.mind, mind),
          eq(summaries.period, childPeriod),
          like(summaries.period_key, `${periodKey}%`),
        ),
      )
      .orderBy(summaries.period_key);
    return {
      texts: rows.map((r) => r.content),
      sourceIds: rows.map((r) => r.id),
    };
  }

  // Week and month: read daily summaries within date range
  const { start, end } = getTimeRange(periodKey, period);
  const startKey = start.slice(0, 10);
  const endKey = end.slice(0, 10);
  const rows = await db
    .select({ id: summaries.id, content: summaries.content })
    .from(summaries)
    .where(
      and(
        eq(summaries.mind, mind),
        eq(summaries.period, childPeriod),
        gte(summaries.period_key, startKey),
        sql`${summaries.period_key} <= ${endKey}`,
      ),
    )
    .orderBy(summaries.period_key);
  return {
    texts: rows.map((r) => r.content),
    sourceIds: rows.map((r) => r.id),
  };
}

export async function summarizePeriod(
  mind: string,
  period: TimerPeriod,
  periodKey: string,
): Promise<boolean> {
  const db = await getDb();

  // Idempotency check
  const existing = await db
    .select({ id: summaries.id })
    .from(summaries)
    .where(
      and(
        eq(summaries.mind, mind),
        eq(summaries.period, period),
        eq(summaries.period_key, periodKey),
      ),
    )
    .get();
  if (existing) return false;

  const sources = await gatherChildSummaries(mind, period, periodKey);
  if (sources.texts.length === 0) return false;

  // If there's only one child summary, promote it directly instead of
  // generating a redundant wrapper. E.g. an hour with one turn doesn't
  // need a separate hourly summary — the turn summary *is* the hourly summary.
  if (sources.texts.length === 1) {
    try {
      await db
        .insert(summaries)
        .values({
          mind,
          period,
          period_key: periodKey,
          content: sources.texts[0],
          metadata: JSON.stringify({
            deterministic: false,
            promoted: true,
            source_count: 1,
            source_ids: sources.sourceIds,
          }),
        })
        .onConflictDoNothing();
    } catch (err) {
      sLog.error(
        `failed to persist promoted ${period} summary for ${mind} (${periodKey})`,
        log.errorData(err),
      );
      return false;
    }
    sLog.info(`promoted single-child ${period} summary for ${mind} (${periodKey})`);
    return true;
  }

  const promptKey = `meta_summary_${period}` as const;
  const scopeInstruction = getScopeInstruction(mind);
  const systemPrompt = await getPrompt(promptKey, { scope_instruction: scopeInstruction });
  const userMessage = sources.texts.join("\n\n---\n\n");

  let content: string;
  let deterministic: boolean;

  const aiResult = await aiCompleteUtility(systemPrompt, userMessage);
  if (aiResult) {
    content = aiResult;
    deterministic = false;
  } else {
    content = buildPeriodicDeterministicSummary(sources.texts, period, periodKey);
    deterministic = true;
  }

  const metadata: Record<string, unknown> = {
    deterministic,
    source_count: sources.texts.length,
    source_ids: sources.sourceIds,
  };

  try {
    await db
      .insert(summaries)
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

// ── System-level summaries ──

async function summarizeSystem(period: TimerPeriod, periodKey: string): Promise<void> {
  const db = await getDb();

  const existing = await db
    .select({ id: summaries.id })
    .from(summaries)
    .where(
      and(
        eq(summaries.mind, SYSTEM_MIND),
        eq(summaries.period, period),
        eq(summaries.period_key, periodKey),
      ),
    )
    .get();
  if (existing) return;

  const rows = await db
    .select({ mind: summaries.mind, content: summaries.content })
    .from(summaries)
    .where(
      and(
        eq(summaries.period, period),
        eq(summaries.period_key, periodKey),
        sql`${summaries.mind} != ${SYSTEM_MIND}`,
      ),
    )
    .orderBy(summaries.mind);

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
    content = buildPeriodicDeterministicSummary(texts, period, periodKey);
    deterministic = true;
  }

  try {
    await db
      .insert(summaries)
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

// ── Tick logic ──

async function mindsWithTurnSummaries(start: string, end: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .select({ mind: summaries.mind })
    .from(summaries)
    .where(
      and(
        eq(summaries.period, "turn"),
        gte(summaries.created_at, start),
        lt(summaries.created_at, end),
        sql`${summaries.mind} != ${SYSTEM_MIND}`,
      ),
    )
    .groupBy(summaries.mind);
  return rows.map((r) => r.mind);
}

async function mindsWithSummaries(period: TimerPeriod, keyPattern: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .select({ mind: summaries.mind })
    .from(summaries)
    .where(
      and(
        eq(summaries.period, period),
        like(summaries.period_key, keyPattern),
        sql`${summaries.mind} != ${SYSTEM_MIND}`,
      ),
    )
    .groupBy(summaries.mind);
  return rows.map((r) => r.mind);
}

async function mindsWithDailySummariesInRange(startKey: string, endKey: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .select({ mind: summaries.mind })
    .from(summaries)
    .where(
      and(
        eq(summaries.period, "day"),
        gte(summaries.period_key, startKey),
        sql`${summaries.period_key} <= ${endKey}`,
        sql`${summaries.mind} != ${SYSTEM_MIND}`,
      ),
    )
    .groupBy(summaries.mind);
  return rows.map((r) => r.mind);
}

async function processHour(periodKey: string): Promise<void> {
  const { start, end } = getTimeRange(periodKey, "hour");
  const minds = await mindsWithTurnSummaries(start, end);
  for (const mind of minds) {
    try {
      await summarizePeriod(mind, "hour", periodKey);
    } catch (err) {
      sLog.error(`failed to summarize hour for ${mind} (${periodKey})`, log.errorData(err));
    }
  }
  if (minds.length > 0) {
    await summarizeSystem("hour", periodKey);
  }
}

async function processDay(periodKey: string): Promise<void> {
  const minds = await mindsWithSummaries("hour", `${periodKey}%`);
  for (const mind of minds) {
    try {
      await summarizePeriod(mind, "day", periodKey);
    } catch (err) {
      sLog.error(`failed to summarize day for ${mind} (${periodKey})`, log.errorData(err));
    }
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
    try {
      await summarizePeriod(mind, "week", periodKey);
    } catch (err) {
      sLog.error(`failed to summarize week for ${mind} (${periodKey})`, log.errorData(err));
    }
  }
  if (minds.length > 0) {
    await summarizeSystem("week", periodKey);
  }
}

async function processMonth(periodKey: string): Promise<void> {
  const minds = await mindsWithSummaries("day", `${periodKey}%`);
  for (const mind of minds) {
    try {
      await summarizePeriod(mind, "month", periodKey);
    } catch (err) {
      sLog.error(`failed to summarize month for ${mind} (${periodKey})`, log.errorData(err));
    }
  }
  if (minds.length > 0) {
    await summarizeSystem("month", periodKey);
  }
}

async function summaryExists(
  mind: string,
  period: TimerPeriod,
  periodKey: string,
): Promise<boolean> {
  const db = await getDb();
  const row = await db
    .select({ id: summaries.id })
    .from(summaries)
    .where(
      and(
        eq(summaries.mind, mind),
        eq(summaries.period, period),
        eq(summaries.period_key, periodKey),
      ),
    )
    .get();
  return !!row;
}

async function backfill(): Promise<void> {
  const now = new Date();

  for (let i = 1; i <= 48; i++) {
    const d = new Date(now);
    d.setUTCHours(d.getUTCHours() - i);
    const key = getPeriodKey(d, "hour");
    if (!(await summaryExists(SYSTEM_MIND, "hour", key))) {
      await processHour(key);
    }
  }

  for (let i = 1; i <= 7; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const key = getPeriodKey(d, "day");
    if (!(await summaryExists(SYSTEM_MIND, "day", key))) {
      await processDay(key);
    }
  }

  for (let i = 1; i <= 4; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i * 7);
    const key = getPeriodKey(d, "week");
    if (!(await summaryExists(SYSTEM_MIND, "week", key))) {
      await processWeek(key);
    }
  }

  for (let i = 1; i <= 3; i++) {
    const d = new Date(now);
    d.setUTCMonth(d.getUTCMonth() - i);
    const key = getPeriodKey(d, "month");
    if (!(await summaryExists(SYSTEM_MIND, "month", key))) {
      await processMonth(key);
    }
  }
}

// ── Summarizer class ──

export class Summarizer {
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastHourKey: string | null = null;
  private hasBackfilled = false;

  start(): void {
    this.interval = setInterval(() => this.tick(), 5 * 60_000);
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
      if (!this.hasBackfilled) {
        await backfill();
        this.hasBackfilled = true;
      }

      const now = new Date();
      const currentHourKey = getPeriodKey(now, "hour");

      if (this.lastHourKey && this.lastHourKey !== currentHourKey) {
        await processHour(this.lastHourKey);
      }
      this.lastHourKey = currentHourKey;

      const yesterday = new Date(now);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const yesterdayKey = getPeriodKey(yesterday, "day");
      if (!(await summaryExists(SYSTEM_MIND, "day", yesterdayKey))) {
        await processDay(yesterdayKey);
      }

      const currentWeekKey = getPeriodKey(now, "week");
      const prevWeekKey = getPreviousPeriodKey(currentWeekKey, "week");
      if (!(await summaryExists(SYSTEM_MIND, "week", prevWeekKey))) {
        await processWeek(prevWeekKey);
      }

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

let instance: Summarizer | null = null;

export function initSummarizer(): Summarizer {
  if (instance) throw new Error("Summarizer already initialized");
  instance = new Summarizer();
  return instance;
}
