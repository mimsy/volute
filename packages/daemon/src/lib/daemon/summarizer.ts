import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, desc, eq, gte, inArray, like, lt, sql } from "drizzle-orm";
import { aiCompleteUtility } from "../ai-service.js";
import { getUserByUsername } from "../auth.js";
import { getDb } from "../db.js";
import { publish as publishMindEvent } from "../events/mind-events.js";
import { resolveMindDir } from "../mind/registry.js";
import { getPrompt } from "../prompts.js";
import { messages, mindHistory, summaries, turns } from "../schema.js";
import { summarizeTool } from "../util/format-tool.js";
import log from "../util/logger.js";
import {
  getPeriodKey,
  getPreviousPeriodKey,
  getTimeRange,
  parseUtcDateTime,
  type TimerPeriod,
  utcDateTimeStr,
} from "../util/period-keys.js";
import { parseDbTimestamp } from "../util/time.js";

const sLog = log.child("summarizer");

export { getPeriodKey, getPreviousPeriodKey, getTimeRange, type TimerPeriod };

/** All summary periods including event-driven turn summaries */
export type Period = "turn" | TimerPeriod;

export const SYSTEM_MIND = "_system";

/**
 * A turn that has received a `done` but stayed `active` this long (no further events) is
 * treated as wedged by a leaked delivery counter and force-completed by the tick sweep.
 * The sweep also requires a prior `done`, so genuine in-progress work (no `done` yet) is
 * never cut short regardless of duration; this threshold just bounds how stale a finished
 * turn must look before we step in.
 */
const WEDGED_TURN_IDLE_MS = 15 * 60_000;

// ── Turn summarization (event-driven) ──

export type HistoryRow = {
  id: number;
  type: string;
  channel: string | null;
  session: string | null;
  sender: string | null;
  content: string | null;
  metadata: string | null;
  turn_id: string | null;
  created_at: string;
};

async function gatherTurnEvents(
  mind: string,
  session: string | undefined,
  doneId: number,
): Promise<{ events: HistoryRow[]; fromId: number; toId: number }> {
  const db = await getDb();

  // Find previous done event ID using a subquery in the main query
  const subConditions = [
    eq(mindHistory.mind, mind),
    eq(mindHistory.type, "done"),
    lt(mindHistory.id, doneId),
  ];
  if (session) subConditions.push(eq(mindHistory.thread, session));

  const prevDoneSubquery = db
    .select({ id: mindHistory.id })
    .from(mindHistory)
    .where(and(...subConditions))
    .orderBy(desc(mindHistory.id))
    .limit(1);

  const turnConditions = [
    eq(mindHistory.mind, mind),
    sql`${mindHistory.id} > COALESCE((${prevDoneSubquery}), 0)`,
    sql`${mindHistory.id} <= ${doneId}`,
  ];
  if (session) turnConditions.push(eq(mindHistory.thread, session));

  const events = await db
    .select({
      id: mindHistory.id,
      type: mindHistory.type,
      channel: mindHistory.channel,
      session: mindHistory.thread,
      sender: mindHistory.sender,
      content: mindHistory.content,
      metadata: mindHistory.metadata,
      turn_id: mindHistory.turn_id,
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
      session: mindHistory.thread,
      sender: mindHistory.sender,
      content: mindHistory.content,
      metadata: mindHistory.metadata,
      turn_id: mindHistory.turn_id,
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

function parseEventMetadata(events: HistoryRow[]): Map<number, Record<string, unknown>> {
  const parsed = new Map<number, Record<string, unknown>>();
  for (const ev of events) {
    if (ev.metadata) {
      try {
        parsed.set(ev.id, JSON.parse(ev.metadata));
      } catch (err) {
        sLog.debug(`failed to parse metadata for event ${ev.id}`, log.errorData(err));
      }
    }
  }
  return parsed;
}

function buildTurnDeterministicSummary(
  events: HistoryRow[],
  parsedMeta: Map<number, Record<string, unknown>>,
): string {
  const channels = new Set<string>();
  const tools: string[] = [];
  let hasInbound = false;
  let hasOutbound = false;
  let eventLabel: string | undefined;

  for (const ev of events) {
    if (ev.type === "inbound") {
      hasInbound = true;
      if (ev.channel) channels.add(ev.channel);
    }
    // Events need naming here too, not only in buildTranscript. This is the fallback used
    // whenever aiCompleteUtility() returns null (AI unconfigured, 401, rate-limited, expired
    // OAuth) — without it a schedule/orientation/wake turn degrades to a bare "Turn completed."
    // and the trigger vanishes precisely when a host is least able to see what happened.
    if (ev.type === "event") {
      const label = parsedMeta.get(ev.id)?.label;
      eventLabel = typeof label === "string" && label ? label : "System event";
    }
    if (ev.type === "outbound" || ev.type === "text") {
      hasOutbound = true;
    }
    if (ev.type === "tool_use") {
      const meta = parsedMeta.get(ev.id);
      if (meta?.name) tools.push(meta.name as string);
    }
  }

  const parts: string[] = [];
  if (eventLabel) {
    parts.push(`System event: ${eventLabel}`);
  }
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

export function buildTranscript(
  events: HistoryRow[],
  parsedMeta: Map<number, Record<string, unknown>>,
  mind: string,
): string {
  const lines: string[] = [];
  for (const ev of events) {
    switch (ev.type) {
      // Inbound messages come from *other* people. Attribute them to the sender by name (and
      // channel) so the summarizer never absorbs someone else's first-person statements into
      // the mind's own "I" in a multi-party channel.
      case "inbound": {
        const on = ev.channel ? ` on ${ev.channel}` : "";
        const from = ev.sender ? ` from ${ev.sender}` : "";
        lines.push(`[inbound${on}${from}] ${ev.content ?? ""}`);
        break;
      }
      // A system event is what triggered the turn — the summarizer needs to see it, or a
      // schedule/orientation/wake turn gets summarized from its tool calls alone, with no
      // idea what prompted them. Framed as an event, not an inbound message: it has no
      // sender, and the summary shouldn't imply someone spoke to the mind.
      case "event": {
        const label = parsedMeta.get(ev.id)?.label;
        const named = typeof label === "string" && label ? `: ${label}` : "";
        lines.push(`[system event${named}] ${ev.content ?? ""}`);
        break;
      }
      // The mind's own output/thoughts, labeled with its name so the "I" is unambiguous. Never
      // truncated — a mid-sentence fragment is worse than a long line, because the model
      // interpolates over the cut and invents a false memory.
      case "outbound":
      case "text":
        lines.push(`[${mind} replied] ${ev.content ?? ""}`);
        break;
      case "tool_use": {
        const meta = parsedMeta.get(ev.id);
        const toolInfo = meta
          ? summarizeTool(
              (meta.name as string) ?? "tool",
              (meta.input as Record<string, unknown>) ?? {},
            )
          : "tool";
        lines.push(toolInfo);
        break;
      }
      case "tool_result": {
        const content = ev.content ?? "";
        const meta = parsedMeta.get(ev.id);
        const isError = !!meta?.is_error;
        lines.push(
          isError ? `[result error] ${content.slice(0, 200)}` : `[result] ${content.slice(0, 200)}`,
        );
        break;
      }
      case "thinking":
        lines.push(`[${mind} thinking] ${ev.content ?? ""}`);
        break;
    }
  }
  return lines.join("\n");
}

/**
 * A one-line identity for the mind (display name + description from its users-table profile),
 * prepended to the turn-summary input so the summarizer knows whose voice it's writing in.
 * Returns "" when the mind has no profile or the lookup fails — the summary proceeds without it.
 */
async function getMindIdentityLine(mind: string): Promise<string> {
  try {
    const user = await getUserByUsername(mind);
    if (!user) return "";
    const name = user.display_name?.trim();
    const desc = user.description?.trim();
    if (!name && !desc) return "";
    const who = name ? `${mind} (${name})` : mind;
    return `[about the mind] ${who}${desc ? `: ${desc}` : ""}`;
  } catch (err) {
    sLog.debug(`failed to load identity for ${mind}`, log.errorData(err));
    return "";
  }
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

  // Resolve the turn this summary belongs to. When called without an explicit `turnId`
  // (completeTurn returned undefined because a wedged-turn sweep already completed the turn),
  // reuse the turn_id the events already carry so the summary keys on the turn UUID and
  // dedupes — instead of minting a "<mind>-<doneId>" key that produces a SECOND summary for
  // the same turn (see #395).
  const effectiveTurnId = turnId ?? events.find((ev) => ev.turn_id)?.turn_id ?? undefined;

  // If a summary for this turn already exists (the sweep summarized it first), stop here —
  // this also short-circuits the redundant AI call.
  if (effectiveTurnId && (await summaryExists(mind, "turn", effectiveTurnId))) return;

  // Detect interrupted turns
  const substantiveTypes = new Set(["text", "outbound", "tool_use", "tool_result", "thinking"]);
  const hasSubstantiveOutput = events.some((ev) => substantiveTypes.has(ev.type));
  if (!hasSubstantiveOutput) {
    sLog.info(
      `skipping summary for interrupted turn ${effectiveTurnId ?? "(no turn)"} (no substantive output)`,
    );
    if (effectiveTurnId) {
      try {
        const db = await getDb();
        await db
          .update(mindHistory)
          .set({ turn_id: null })
          .where(
            and(
              eq(mindHistory.turn_id, effectiveTurnId),
              // Release system-event rows too, so an interrupted event turn's row can be
              // re-linked to the turn that actually processes it.
              inArray(mindHistory.type, ["inbound", "event"]),
            ),
          );
        await db
          .update(messages)
          .set({ turn_id: null })
          .where(eq(messages.turn_id, effectiveTurnId));
        // The turn produced nothing — no output, no summary. Delete the row so it can't come
        // back from /history/turns as a junk "(no summary)" orphan (see #395).
        await db.delete(turns).where(eq(turns.id, effectiveTurnId));
      } catch (err) {
        sLog.error(`failed to clean up interrupted turn ${effectiveTurnId}`, log.errorData(err));
      }
    }
    return;
  }

  const parsedMeta = parseEventMetadata(events);

  const tools: string[] = [];
  for (const ev of events) {
    if (ev.type === "tool_use") {
      const meta = parsedMeta.get(ev.id);
      if (meta?.name) tools.push(meta.name as string);
    }
  }

  const fromTime = events[0].created_at;
  const toTime = events[events.length - 1].created_at;

  let summaryText: string;
  let deterministic: boolean;

  const transcript = buildTranscript(events, parsedMeta, mind);
  if (transcript.trim()) {
    const summaryPrompt = await getPrompt("turn_summary", { mind });
    const identity = await getMindIdentityLine(mind);
    const input = identity ? `${identity}\n\n${transcript}` : transcript;
    const aiResult = await aiCompleteUtility(summaryPrompt, input);
    if (aiResult) {
      summaryText = aiResult;
      deterministic = false;
    } else {
      summaryText = buildTurnDeterministicSummary(events, parsedMeta);
      deterministic = true;
    }
  } else {
    summaryText = buildTurnDeterministicSummary(events, parsedMeta);
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
  const periodKey = effectiveTurnId ?? `${mind}-${doneId}`;
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
  if (effectiveTurnId && summaryId != null) {
    setSummaryId(effectiveTurnId, summaryId).catch((err) => {
      sLog.error(`failed to link summary to turn ${effectiveTurnId}`, log.errorData(err));
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
    turnId: effectiveTurnId,
  });
}

/** Update a turn's summary_id. */
async function setSummaryId(turnId: string, summaryId: number): Promise<void> {
  const db = await getDb();
  await db.update(turns).set({ summary_id: summaryId }).where(eq(turns.id, turnId));
}

// ── Mind-authored turn summaries ──

/** Max length of a mind-authored turn summary (matches the API's validation cap). */
export const MIND_TURN_SUMMARY_MAX_CHARS = 4000;

export type MindTurnSummaryResult =
  | { status: "ok"; created: boolean }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "invalid"; error: string };

/**
 * Supersede a turn's provisional (summarizer-authored) summary with the mind's own words.
 *
 * The automatic summarizer stays the provisional record; this lets a mind replace a turn's row
 * with its own account. It overwrites the `period:"turn"` row in place, marks it `author: "mind"`,
 * and preserves the replaced provisional text under `metadata.superseded` (kept stable across
 * repeated edits so the original auto-summary is never lost). When no summary row exists yet — the
 * mind got here before the automatic summarizer ran — it inserts one and links `turns.summary_id`;
 * `summarizeTurn`'s `summaryExists` guard then skips that turn, so the mind's account is respected.
 *
 * Only `period:"turn"` rows owned by `mind` are ever touched; rollups and `_system` rows are not.
 */
export async function supersedeTurnSummary(
  mind: string,
  turnId: string,
  content: string,
): Promise<MindTurnSummaryResult> {
  const text = content.trim();
  if (!text) return { status: "invalid", error: "content is required" };
  if (text.length > MIND_TURN_SUMMARY_MAX_CHARS) {
    return {
      status: "invalid",
      error: `content exceeds ${MIND_TURN_SUMMARY_MAX_CHARS} characters`,
    };
  }

  const db = await getDb();
  const turn = await db.select().from(turns).where(eq(turns.id, turnId)).get();
  if (!turn) return { status: "not_found" };
  if (turn.mind !== mind) return { status: "forbidden" };

  const existing = await db
    .select({ id: summaries.id, content: summaries.content, metadata: summaries.metadata })
    .from(summaries)
    .where(
      and(eq(summaries.mind, mind), eq(summaries.period, "turn"), eq(summaries.period_key, turnId)),
    )
    .get();

  const authoredAt = utcDateTimeStr(new Date());
  let created: boolean;

  if (existing) {
    const prevMeta = parseMeta(existing.metadata);
    // Preserve the replaced provisional: on a re-edit keep the ORIGINAL provisional (already
    // captured), otherwise capture the row being replaced now, so the auto-summary survives.
    let superseded = prevMeta.superseded;
    if (superseded === undefined) {
      const captured: Record<string, unknown> = { content: existing.content };
      if (typeof prevMeta.deterministic === "boolean")
        captured.deterministic = prevMeta.deterministic;
      superseded = captured;
    }
    const metadata = { ...prevMeta, author: "mind", authored_at: authoredAt, superseded };
    await db
      .update(summaries)
      .set({ content: text, metadata: JSON.stringify(metadata) })
      .where(eq(summaries.id, existing.id));
    created = false;
  } else {
    const metadata = { author: "mind", authored_at: authoredAt };
    const result = await db
      .insert(summaries)
      .values({
        mind,
        period: "turn",
        period_key: turnId,
        content: text,
        metadata: JSON.stringify(metadata),
      })
      .returning({ id: summaries.id });
    const summaryId = result[0]?.id;
    if (summaryId != null && turn.summary_id == null) {
      await setSummaryId(turnId, summaryId);
    }
    created = true;
  }

  publishMindEvent(mind, {
    mind,
    type: "summary",
    session: turn.thread ?? undefined,
    content: text,
    metadata: { author: "mind", authored_at: authoredAt },
    turnId,
  });

  return { status: "ok", created };
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

// ── Deterministic fallback bounding & provisional retry ──

/**
 * Week/month deterministic fallbacks are an *index* of their children, not a verbatim
 * concatenation: one bounded line per child, capped in total. This keeps a failed AI call
 * from producing a 100k+ char blob that then poisons the next period's rollup.
 */
const DIGEST_CHILD_CHARS = 200;
const DIGEST_MAX_CHARS = 4000;
const DIGEST_NOTICE = "(auto-generated digest — AI summary pending)";

/** When rolling per-mind summaries into a _system summary, cap each child fed to the AI. */
const ROLLUP_CHILD_CHARS = 2000;

/**
 * A deterministic week/month summary is *provisional*: the summarizer retries it on later
 * ticks (replacing the row on AI success) until it heals or the budget runs out. This bounds
 * the "one transient AI outage scars a month forever" failure mode and heals existing blobs.
 */
const PROVISIONAL_MAX_ATTEMPTS = 5;
const PROVISIONAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Minimum spacing between provisional retries. The summarizer tick runs every 5 minutes and
 * `repairProvisionalSummaries` retries every due row on each tick, so without spacing the whole
 * attempt budget would burn in ~25 minutes — the 7-day window would never bind and any AI outage
 * longer than that would scar the summary permanently. Spacing the attempts (~1.4 days apart) makes
 * the budget genuinely span the window, so the row heals whenever the AI recovers within a week.
 */
const PROVISIONAL_RETRY_BACKOFF_MS = PROVISIONAL_WINDOW_MS / PROVISIONAL_MAX_ATTEMPTS;

type ChildEntry = { key: string; text: string };

function truncateChars(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}

/** First sentence (or first ~200 chars) of a child summary, whitespace-flattened. */
function digestLine(text: string): string {
  const flat = text.trim().replace(/\s+/g, " ");
  const match = flat.match(/^.*?[.!?](?=\s|$)/);
  const line = match ? match[0] : flat;
  return line.length > DIGEST_CHILD_CHARS
    ? `${line.slice(0, DIGEST_CHILD_CHARS).trimEnd()}…`
    : line;
}

function buildBoundedDigest(entries: ChildEntry[], period: TimerPeriod, periodKey: string): string {
  const label = period === "week" ? `Week ${periodKey}` : periodKey;
  const header = `${label} ${DIGEST_NOTICE}`;
  const lines: string[] = [];
  let total = header.length + 2;
  for (let i = 0; i < entries.length; i++) {
    const line = `${entries[i].key}: ${digestLine(entries[i].text)}`;
    if (lines.length > 0 && total + line.length + 1 > DIGEST_MAX_CHARS) {
      lines.push(`…and ${entries.length - i} more`);
      break;
    }
    lines.push(line);
    total += line.length + 1;
  }
  return `${header}\n\n${lines.join("\n")}`;
}

function buildPeriodicDeterministicSummary(
  entries: ChildEntry[],
  period: TimerPeriod,
  periodKey: string,
): string {
  if (entries.length === 0) return "";
  switch (period) {
    case "hour":
      return `Activity during ${periodKey.slice(11)}:00: ${entries.map((e) => e.text).join(" ")}`;
    case "day":
      return `Activity on ${periodKey}:\n\n${entries.map((e) => e.text).join("\n\n")}`;
    case "week":
    case "month":
      return buildBoundedDigest(entries, period, periodKey);
  }
}

/**
 * Matches a deterministic week/month digest header ("Week <key> (notice)\n\n" or
 * "<key> (notice)\n\n") at the start of a child summary. Built from DIGEST_NOTICE so it can't
 * drift from the emitted header.
 */
const DIGEST_HEADER_PREFIX = new RegExp(
  `^(?:Week )?\\S+ ${DIGEST_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n\\n`,
);

/**
 * Strip a leading deterministic period prefix ("Activity during HH:00: " / "Activity on
 * YYYY-MM-DD:\n\n") or week/month digest header so the system rollup doesn't double it when its
 * per-mind children were themselves deterministic. Anchored, so AI-generated children (no such
 * prefix) pass through untouched.
 */
function stripPeriodPrefix(text: string): string {
  return text
    .replace(/^Activity during \d{2}:00: /, "")
    .replace(/^Activity on \d{4}-\d{2}-\d{2}:\n\n/, "")
    .replace(DIGEST_HEADER_PREFIX, "");
}

/**
 * Deterministic fallback for the `_system` rollup. Unlike the per-mind builder, its children
 * are per-mind period summaries — so it keeps per-mind attribution (`[mind]` for hour/day,
 * `mind:` digest lines for week/month) and strips each child's own period prefix, applying
 * the period prefix exactly once (see #566).
 */
function buildSystemDeterministicSummary(
  entries: ChildEntry[],
  period: TimerPeriod,
  periodKey: string,
): string {
  if (entries.length === 0) return "";
  const stripped = entries.map((e) => ({ key: e.key, text: stripPeriodPrefix(e.text) }));
  switch (period) {
    case "hour":
      return `Activity during ${periodKey.slice(11)}:00: ${stripped.map((e) => `[${e.key}] ${e.text}`).join(" ")}`;
    case "day":
      return `Activity on ${periodKey}:\n\n${stripped.map((e) => `[${e.key}] ${e.text}`).join("\n\n")}`;
    case "week":
    case "month":
      // The digest already attributes per mind (`key: …` lines); stripping keeps a
      // deterministic daily child's own "Activity on …" prefix out of its digest line.
      return buildBoundedDigest(stripped, period, periodKey);
  }
}

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Whether an existing deterministic week/month row should be retried. True while it's a
 * provisional (deterministic) week/month summary that hasn't exhausted its attempt budget or
 * aged out of the retry window. Rows written before this feature (no `attempts`/
 * `first_attempt_at`) are treated as fresh, so upgrades heal them.
 */
function shouldRetry(period: TimerPeriod, meta: Record<string, unknown>): boolean {
  if (period !== "week" && period !== "month") return false;
  if (meta.deterministic !== true) return false;
  const attempts = typeof meta.attempts === "number" ? meta.attempts : 0;
  if (attempts >= PROVISIONAL_MAX_ATTEMPTS) return false;
  const first = typeof meta.first_attempt_at === "string" ? Date.parse(meta.first_attempt_at) : NaN;
  if (!Number.isNaN(first) && Date.now() - first > PROVISIONAL_WINDOW_MS) return false;
  // Space attempts across the window so the tick cadence can't burn the whole budget in minutes.
  // A row with no `last_attempt_at` (a pre-feature blob, or one never retried) is eligible
  // immediately — so upgrades heal on the next tick and only repeated *failures* get backed off.
  const last = typeof meta.last_attempt_at === "string" ? Date.parse(meta.last_attempt_at) : NaN;
  if (!Number.isNaN(last) && Date.now() - last < PROVISIONAL_RETRY_BACKOFF_MS) return false;
  return true;
}

/** Fold retry-budget bookkeeping into a provisional (deterministic) week/month row's metadata. */
function trackProvisionalAttempt(
  metadata: Record<string, unknown>,
  prev: Record<string, unknown> | null,
): void {
  const prevAttempts = prev && typeof prev.attempts === "number" ? prev.attempts : 0;
  metadata.attempts = prevAttempts + 1;
  metadata.first_attempt_at =
    prev && typeof prev.first_attempt_at === "string"
      ? prev.first_attempt_at
      : new Date().toISOString();
  metadata.last_attempt_at = new Date().toISOString();
}

/**
 * A short temporal label identifying a child within its parent period, prefixed to each child
 * in the AI rollup input so the model can order events in time without guessing. Turn keys are
 * UUIDs, so hour rollups label their turn-children by wall-clock time (HH:MM, server-local);
 * day rollups label hour-children HH:00; week/month rollups label day-children by date.
 */
function childLabel(period: TimerPeriod, key: string, createdAt: string): string {
  switch (period) {
    case "hour": {
      const d = parseDbTimestamp(createdAt);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return `${hh}:${mm}`;
    }
    case "day":
      // hour key = "YYYY-MM-DDTHH"
      return `${key.slice(11)}:00`;
    case "week":
    case "month":
      // day key = "YYYY-MM-DD"
      return key;
  }
}

async function gatherChildSummaries(
  mind: string,
  period: TimerPeriod,
  periodKey: string,
): Promise<{ texts: string[]; sourceIds: number[]; keys: string[]; labels: string[] }> {
  const db = await getDb();
  const childPeriod = getChildPeriod(period);

  if (period === "hour") {
    // Hour reads turn summaries; turn period_keys aren't date-based,
    // so we filter by created_at time range instead
    const { start, end } = getTimeRange(periodKey, "hour");
    const rows = await db
      .select({
        id: summaries.id,
        content: summaries.content,
        key: summaries.period_key,
        created_at: summaries.created_at,
      })
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
      keys: rows.map((r) => r.key),
      labels: rows.map((r) => childLabel(period, r.key, r.created_at)),
    };
  }

  if (period === "day") {
    // Day reads hourly summaries whose period_key starts with the day
    const rows = await db
      .select({ id: summaries.id, content: summaries.content, key: summaries.period_key })
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
      keys: rows.map((r) => r.key),
      labels: rows.map((r) => childLabel(period, r.key, "")),
    };
  }

  // Week and month: read daily summaries within date range
  const { start, end } = getTimeRange(periodKey, period);
  const startKey = start.slice(0, 10);
  const endKey = end.slice(0, 10);
  const rows = await db
    .select({ id: summaries.id, content: summaries.content, key: summaries.period_key })
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
    keys: rows.map((r) => r.key),
    labels: rows.map((r) => childLabel(period, r.key, "")),
  };
}

/**
 * Read a mind's SOUL.md for use as voice/perspective context in its week/month rollups, capped
 * so a pathological file can't blow up the AI call. Missing or unreadable → "".
 */
const SOUL_MAX_CHARS = 8000;

async function readMindSoul(mind: string): Promise<string> {
  try {
    const dir = await resolveMindDir(mind);
    const soul = await readFile(join(dir, "home", "SOUL.md"), "utf8");
    return soul.length > SOUL_MAX_CHARS ? soul.slice(0, SOUL_MAX_CHARS) : soul;
  } catch {
    return "";
  }
}

export async function summarizePeriod(
  mind: string,
  period: TimerPeriod,
  periodKey: string,
  complete: typeof aiCompleteUtility = aiCompleteUtility,
): Promise<boolean> {
  const db = await getDb();
  const existing = await db
    .select({ id: summaries.id, metadata: summaries.metadata })
    .from(summaries)
    .where(
      and(
        eq(summaries.mind, mind),
        eq(summaries.period, period),
        eq(summaries.period_key, periodKey),
      ),
    )
    .get();
  const existingMeta = existing ? parseMeta(existing.metadata) : null;
  // A finished summary is skipped, but a provisional (deterministic) week/month is retried.
  if (existing && !shouldRetry(period, existingMeta as Record<string, unknown>)) return false;

  const sources = await gatherChildSummaries(mind, period, periodKey);
  if (sources.texts.length === 0) return false;

  // If there's only one child summary, promote it directly instead of
  // generating a redundant wrapper. E.g. an hour with one turn doesn't
  // need a separate hourly summary — the turn summary *is* the hourly summary.
  // (Only for fresh summaries; a provisional retry falls through to the AI path.)
  if (!existing && sources.texts.length === 1) {
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

  const entries: ChildEntry[] = sources.texts.map((text, i) => ({ key: sources.keys[i], text }));
  const promptKey = `meta_summary_${period}` as const;
  const scopeInstruction = getScopeInstruction(mind);
  let systemPrompt = await getPrompt(promptKey, { scope_instruction: scopeInstruction });
  // Week/month per-mind rollups get the mind's SOUL.md as voice/perspective context, so the
  // reflective summary sounds like the mind rather than a neutral narrator. Hour/day, turn, and
  // _system summaries do not — this is the mind's own long-arc self-narrative.
  if (period === "week" || period === "month") {
    const soul = await readMindSoul(mind);
    if (soul.trim()) {
      systemPrompt = `${systemPrompt}\n\nFor voice and perspective, this is the mind's own self-description (SOUL.md):\n\n${soul.trim()}`;
    }
  }
  // Prefix each child with its temporal label so the model can order events in time. The label
  // convention is documented in the meta_summary prompts, which also tell the model not to echo
  // the brackets.
  const userMessage = sources.texts
    .map((text, i) => `[${sources.labels[i]}] ${text}`)
    .join("\n\n---\n\n");

  let content: string;
  let deterministic: boolean;

  const metadata: Record<string, unknown> = {
    source_count: sources.texts.length,
    source_ids: sources.sourceIds,
  };

  const aiResult = await complete(systemPrompt, userMessage);
  if (aiResult) {
    content = aiResult;
    deterministic = false;
  } else {
    content = buildPeriodicDeterministicSummary(entries, period, periodKey);
    deterministic = true;
    if (period === "week" || period === "month") trackProvisionalAttempt(metadata, existingMeta);
  }
  metadata.deterministic = deterministic;

  try {
    if (existing) {
      await db
        .update(summaries)
        .set({ content, metadata: JSON.stringify(metadata) })
        .where(eq(summaries.id, existing.id));
    } else {
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
    }
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

export async function summarizeSystem(
  period: TimerPeriod,
  periodKey: string,
  complete: typeof aiCompleteUtility = aiCompleteUtility,
): Promise<void> {
  const db = await getDb();
  const existing = await db
    .select({ id: summaries.id, metadata: summaries.metadata })
    .from(summaries)
    .where(
      and(
        eq(summaries.mind, SYSTEM_MIND),
        eq(summaries.period, period),
        eq(summaries.period_key, periodKey),
      ),
    )
    .get();
  const existingMeta = existing ? parseMeta(existing.metadata) : null;
  if (existing && !shouldRetry(period, existingMeta as Record<string, unknown>)) return;

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
  // Cap each child so one pathological per-mind summary can't blow up the rollup's AI input
  // (or its deterministic fallback).
  const entries: ChildEntry[] = rows.map((r) => ({
    key: r.mind,
    text: truncateChars(r.content, ROLLUP_CHILD_CHARS),
  }));
  const texts = entries.map((e) => `[${e.key}] ${e.text}`);

  const promptKey = `meta_summary_${period}` as const;
  const scopeInstruction = getScopeInstruction(SYSTEM_MIND);
  const systemPrompt = await getPrompt(promptKey, { scope_instruction: scopeInstruction });
  const userMessage = texts.join("\n\n---\n\n");

  let content: string;
  let deterministic: boolean;

  const metadata: Record<string, unknown> = { minds, source_count: rows.length };

  const aiResult = await complete(systemPrompt, userMessage);
  if (aiResult) {
    content = aiResult;
    deterministic = false;
  } else {
    content = buildSystemDeterministicSummary(entries, period, periodKey);
    deterministic = true;
    if (period === "week" || period === "month") trackProvisionalAttempt(metadata, existingMeta);
  }
  metadata.deterministic = deterministic;

  try {
    if (existing) {
      await db
        .update(summaries)
        .set({ content, metadata: JSON.stringify(metadata) })
        .where(eq(summaries.id, existing.id));
    } else {
      await db
        .insert(summaries)
        .values({
          mind: SYSTEM_MIND,
          period,
          period_key: periodKey,
          content,
          metadata: JSON.stringify(metadata),
        })
        .onConflictDoNothing();
    }
  } catch (err) {
    sLog.error(`failed to persist system ${period} summary (${periodKey})`, log.errorData(err));
  }
}

/**
 * Retry provisional (deterministic) week/month summaries that the tick guards would otherwise
 * skip. Per-mind summaries are healed before `_system` so the rollup sees the improved children.
 */
export async function repairProvisionalSummaries(
  complete: typeof aiCompleteUtility = aiCompleteUtility,
): Promise<void> {
  const db = await getDb();
  const rows = await db
    .select({
      mind: summaries.mind,
      period: summaries.period,
      period_key: summaries.period_key,
      metadata: summaries.metadata,
    })
    .from(summaries)
    .where(inArray(summaries.period, ["week", "month"]));
  const due = rows.filter((r) => shouldRetry(r.period as TimerPeriod, parseMeta(r.metadata)));
  due.sort((a, b) => (a.mind === SYSTEM_MIND ? 1 : 0) - (b.mind === SYSTEM_MIND ? 1 : 0));
  for (const r of due) {
    try {
      if (r.mind === SYSTEM_MIND) {
        await summarizeSystem(r.period as TimerPeriod, r.period_key, complete);
      } else {
        await summarizePeriod(r.mind, r.period as TimerPeriod, r.period_key, complete);
      }
    } catch (err) {
      sLog.error(
        `failed to repair provisional ${r.period} summary for ${r.mind} (${r.period_key})`,
        log.errorData(err),
      );
    }
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

async function summaryExists(mind: string, period: Period, periodKey: string): Promise<boolean> {
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

  // Collect all candidate period keys
  const candidates: { period: TimerPeriod; key: string }[] = [];
  for (let i = 1; i <= 48; i++) {
    const d = new Date(now);
    d.setHours(d.getHours() - i);
    candidates.push({ period: "hour", key: getPeriodKey(d, "hour") });
  }
  for (let i = 1; i <= 7; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    candidates.push({ period: "day", key: getPeriodKey(d, "day") });
  }
  for (let i = 1; i <= 4; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i * 7);
    candidates.push({ period: "week", key: getPeriodKey(d, "week") });
  }
  for (let i = 1; i <= 3; i++) {
    const d = new Date(now);
    d.setMonth(d.getMonth() - i);
    candidates.push({ period: "month", key: getPeriodKey(d, "month") });
  }

  // Batch check which summaries already exist
  const allKeys = candidates.map((c) => c.key);
  const db = await getDb();
  const existingRows = await db
    .select({ period: summaries.period, period_key: summaries.period_key })
    .from(summaries)
    .where(and(eq(summaries.mind, SYSTEM_MIND), inArray(summaries.period_key, allKeys)));
  const existingSet = new Set(existingRows.map((r) => `${r.period}:${r.period_key}`));

  const processFn: Record<TimerPeriod, (key: string) => Promise<void>> = {
    hour: processHour,
    day: processDay,
    week: processWeek,
    month: processMonth,
  };

  for (const { period, key } of candidates) {
    if (existingSet.has(`${period}:${key}`)) continue;
    try {
      await processFn[period](key);
    } catch (err) {
      sLog.error(`backfill failed for ${period} ${key}`, log.errorData(err));
    }
  }
}

// ── Gap reconciliation ──

/**
 * Regenerate any period summary that has child material but no summary row of its own.
 * `needed` maps periodKey → the minds that have child summaries for that key. A key is
 * (re)processed when any mind is missing its summary OR the `_system` rollup is missing
 * (per-mind children exist ⇒ a system rollup should too; `process` calls `summarizeSystem`).
 * `process` re-derives minds and is idempotent (summaryExists + the unique
 * (mind, period, period_key) index), so this is safe to run repeatedly.
 */
async function healMissing(
  period: TimerPeriod,
  needed: Map<string, Set<string>>,
  process: (key: string) => Promise<void>,
): Promise<void> {
  if (needed.size === 0) return;
  const db = await getDb();
  const keys = [...needed.keys()];
  const existing = await db
    .select({ mind: summaries.mind, period_key: summaries.period_key })
    .from(summaries)
    .where(and(eq(summaries.period, period), inArray(summaries.period_key, keys)));
  const have = new Set(existing.map((r) => `${r.mind}|${r.period_key}`));

  for (const [key, minds] of needed) {
    // A missing system rollup is itself a gap even when every per-mind summary exists.
    let gap = !have.has(`${SYSTEM_MIND}|${key}`);
    if (!gap) {
      for (const mind of minds) {
        if (!have.has(`${mind}|${key}`)) {
          gap = true;
          break;
        }
      }
    }
    if (!gap) continue;
    try {
      await process(key);
    } catch (err) {
      sLog.error(`reconcile ${period} ${key} failed`, log.errorData(err));
    }
  }
}

function addNeeded(map: Map<string, Set<string>>, key: string, mind: string): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(mind);
}

/**
 * Heal historical gaps left by summarizer errors or daemon downtime: any period with child
 * summaries but no summary of its own gets regenerated. Runs every tick, bounded to a recent
 * lookback so silent gaps self-heal within a tick rather than staying invisible forever.
 * The current in-progress period (hour/day/week/month) is skipped — those are summarized on
 * rollover by the normal tick. Exported for testing.
 */
export async function reconcileMissingSummaries(lookbackDays = 7): Promise<void> {
  const db = await getDb();
  const now = new Date();
  const windowStart = new Date(now);
  windowStart.setDate(windowStart.getDate() - lookbackDays);

  const currentHourKey = getPeriodKey(now, "hour");
  const currentDayKey = getPeriodKey(now, "day");
  const currentWeekKey = getPeriodKey(now, "week");
  const currentMonthKey = getPeriodKey(now, "month");
  const cutoffDayKey = getPeriodKey(windowStart, "day");

  // ── Hours: turn summaries whose local hour lacks an hour summary ──
  const turnRows = await db
    .select({ mind: summaries.mind, created_at: summaries.created_at })
    .from(summaries)
    .where(
      and(
        eq(summaries.period, "turn"),
        gte(summaries.created_at, utcDateTimeStr(windowStart)),
        sql`${summaries.mind} != ${SYSTEM_MIND}`,
      ),
    );
  const neededHours = new Map<string, Set<string>>();
  for (const r of turnRows) {
    const key = getPeriodKey(parseUtcDateTime(r.created_at), "hour");
    if (key === currentHourKey) continue;
    addNeeded(neededHours, key, r.mind);
  }
  await healMissing("hour", neededHours, processHour);

  // ── Days: hour summaries whose day lacks a day summary ──
  const hourRows = await db
    .select({ mind: summaries.mind, period_key: summaries.period_key })
    .from(summaries)
    .where(
      and(
        eq(summaries.period, "hour"),
        gte(summaries.period_key, cutoffDayKey),
        sql`${summaries.mind} != ${SYSTEM_MIND}`,
      ),
    );
  const neededDays = new Map<string, Set<string>>();
  for (const r of hourRows) {
    const key = r.period_key.slice(0, 10);
    if (key === currentDayKey) continue;
    addNeeded(neededDays, key, r.mind);
  }
  await healMissing("day", neededDays, processDay);

  // ── Weeks & months: day summaries whose week/month lacks a summary ──
  // Re-query day summaries so freshly-healed days are considered.
  const dayRows = await db
    .select({ mind: summaries.mind, period_key: summaries.period_key })
    .from(summaries)
    .where(
      and(
        eq(summaries.period, "day"),
        gte(summaries.period_key, cutoffDayKey),
        sql`${summaries.mind} != ${SYSTEM_MIND}`,
      ),
    );
  const neededWeeks = new Map<string, Set<string>>();
  const neededMonths = new Map<string, Set<string>>();
  for (const r of dayRows) {
    const d = new Date(`${r.period_key}T00:00:00`);
    const weekKey = getPeriodKey(d, "week");
    if (weekKey !== currentWeekKey) addNeeded(neededWeeks, weekKey, r.mind);
    const monthKey = r.period_key.slice(0, 7);
    if (monthKey !== currentMonthKey) addNeeded(neededMonths, monthKey, r.mind);
  }
  await healMissing("week", neededWeeks, processWeek);
  await healMissing("month", neededMonths, processMonth);
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

      await reconcileWedgedTurns(WEDGED_TURN_IDLE_MS);
      await reconcileMissingSummaries();

      const now = new Date();
      const currentHourKey = getPeriodKey(now, "hour");

      if (this.lastHourKey && this.lastHourKey !== currentHourKey) {
        await processHour(this.lastHourKey);
      }
      this.lastHourKey = currentHourKey;

      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
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

      // Re-attempt provisional (deterministic) week/month summaries the guards above skip.
      await repairProvisionalSummaries();
    } catch (err) {
      sLog.error("tick failed", log.errorData(err));
    }
  }
}

/**
 * Complete + summarize turns wedged in `active` despite already finishing, and reset the
 * leaked delivery counter that gated them. Guards against a session's `activeCount`
 * drifting positive (deliveries outnumbering `done`s) and blocking turn completion
 * indefinitely. Run on the summarizer tick; exported for direct testing.
 */
export async function reconcileWedgedTurns(idleMs: number): Promise<void> {
  const { sweepWedgedTurns, summarizeOrphanedTurns } = await import("./turn-tracker.js");
  const wedged = await sweepWedgedTurns(idleMs);
  if (wedged.length === 0) return;

  summarizeOrphanedTurns(wedged);

  // Reset the leaked counter so the next turn in each session can complete. If the delivery
  // manager isn't up (startup ordering) there are no in-memory counters to leak, so skipping
  // is correct. clearSessionActive itself no-ops if a fresh delivery raced in.
  const { tryGetDeliveryManager } = await import("../delivery/delivery-manager.js");
  const dm = tryGetDeliveryManager();
  if (!dm) return;
  for (const t of wedged) {
    if (t.session) dm.clearSessionActive(t.mind, t.session, idleMs);
  }
}

let instance: Summarizer | null = null;

export function initSummarizer(): Summarizer {
  if (instance) throw new Error("Summarizer already initialized");
  instance = new Summarizer();
  return instance;
}
