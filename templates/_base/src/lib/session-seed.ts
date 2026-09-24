/**
 * Session seeding.
 *
 * When a mind starts a fresh *persistent* session (no saved session id — e.g.
 * after a sleep archived the live pointer, or an orphaned reference), we seed the
 * new session by copying the tail of the previous session's raw SDK transcript
 * into a new synthetic session file. The Claude Agent SDK then resumes it
 * natively, so the mind experiences the same conversation continuing rather than
 * waking into an empty context.
 *
 * The copy is verbatim: marker lines, thinking blocks, tool_use/tool_result all
 * survive as-is. Only two things are rewritten — the `sessionId` on every line
 * (to the freshly generated session id) and the first chain event's `parentUuid`
 * (nulled, to detach the tail from the dropped history). The exception is a final
 * turn too large for the budget on its own (typically the long tool loop that
 * crossed the context limit): it keeps its opening prompt, marked as trimmed, and
 * its latest whole steps, re-linked onto the prompt.
 *
 * Ahead of the tail go the mind's recall entries — its consolidated memories of the
 * days and hours before the tail, fetched from the daemon and placed in time as
 * `[recall: …]` / memory pairs (see renderRecall). Every seam (restore, rotation,
 * cold reset) seeds the same shape: recollection, verbatim tail, then the seam note
 * on the next prompt.
 *
 * Nothing here throws: any failure returns null so session start is never blocked.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { findClaudeSessionFile } from "./context-breakdown.js";
import { log } from "./logger.js";
import { parseArchiveTimestamp } from "./seed-note.js";

/**
 * Default verbatim-tail budget (estimated tokens) when config omits continuity.seedTokens.
 * Kept short because the tail no longer carries continuity alone: every seam also seeds
 * the mind's recollection ahead of it (see RecallEntry), so the tail only needs the last
 * few whole turns (#1124).
 */
export const DEFAULT_SEED_TOKENS = 10000;

/**
 * Tail budget for a seam that carries no recollection — pi and codex minds, or a claude
 * mind with `memory.recollection.enabled: false` — where the tail carries continuity alone.
 */
export const TAIL_ONLY_SEED_TOKENS = 30000;

/**
 * Most recollection a seam carries (estimated tokens). Past it the oldest entries go
 * first (the week line is kept if it still fits) — see capRecollection.
 */
export const RECALL_TOKEN_CAP = 12000;

// Archived pointers are named `<name>-<timestamp>.json`, where the timestamp is
// `new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16)` → `YYYY-MM-DDTHH-MM`
// (see archiveSessions in the daemon's sleep-manager). Pointers the template writes
// itself (rotation, cold reset) add `-<sessionId>` so two in one minute can't overwrite
// each other, and carry their exact `archivedAt` inside. Matching the strict shape
// after the `<name>-` prefix disambiguates `main-...` from a `main-thread-...`.
const ARCHIVE_SUFFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2})(?:-[A-Za-z0-9-]+)?\.json$/;

type JsonlLine = Record<string, unknown> & {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown; id?: string; type?: string; model?: string };
};

/** A resolved archive pointer: the previous session id and when it was archived. */
export type ArchivedSession = { sessionId: string; archivedAt: number | null };

/**
 * Newest archived session pointer for `<name>` under `<sessionsDir>/archive/`,
 * or null if there's no readable matching pointer. `archivedAt` is the archive time
 * in epoch millis (null if unparseable). Pointers are ordered by their filename minute,
 * and within the newest minute by their own `archivedAt` when they carry one — a
 * minute-only sleep archive ranks at its minute's *end*, so it outranks a rotation or
 * cold-reset pointer written earlier in the same minute.
 */
export function findLatestArchivedSession(
  sessionsDir: string,
  name: string,
): ArchivedSession | null {
  const archiveDir = resolve(sessionsDir, "archive");
  let files: string[];
  try {
    files = readdirSync(archiveDir);
  } catch {
    return null;
  }

  // Rank by the filename minute first (no reads), then open only the newest minute's
  // pointers to break ties by their exact archivedAt; fall back a minute only if none of
  // them is readable. Keeps a restore from parsing every pointer ever archived.
  const prefix = `${name}-`;
  const byMinute = new Map<string, string[]>();
  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    const match = file.slice(prefix.length).match(ARCHIVE_SUFFIX);
    if (!match) continue;
    byMinute.set(match[1], [...(byMinute.get(match[1]) ?? []), file]);
  }
  // Zero-padded ISO minutes, so lexicographic order is chronological.
  for (const minuteKey of [...byMinute.keys()].sort().reverse()) {
    const minute = parseArchiveTimestamp(minuteKey);
    let best: (ArchivedSession & { rank: number }) | null = null;
    for (const file of byMinute.get(minuteKey) ?? []) {
      let data: { sessionId?: unknown; archivedAt?: unknown };
      try {
        data = JSON.parse(readFileSync(resolve(archiveDir, file), "utf-8"));
      } catch {
        continue;
      }
      if (typeof data.sessionId !== "string") continue;
      const exact = typeof data.archivedAt === "number" ? data.archivedAt : null;
      const rank = exact ?? (minute ?? 0) + 59_999;
      if (!best || rank > best.rank) {
        best = { sessionId: data.sessionId, archivedAt: exact ?? minute, rank };
      }
    }
    if (best) return { sessionId: best.sessionId, archivedAt: best.archivedAt };
  }
  return null;
}

/** A chain event is a real conversation node (has a uuid), not a marker line. */
function isChainEvent(o: JsonlLine): boolean {
  return typeof o.uuid === "string" && (o.type === "user" || o.type === "assistant");
}

/**
 * A turn boundary is a genuine incoming prompt: a `user` chain event whose
 * content is NOT tool_result blocks (those are tool-loop continuations, not the
 * start of a new turn).
 */
function isTurnBoundary(o: JsonlLine): boolean {
  if (o.type !== "user" || typeof o.uuid !== "string") return false;
  const content = o.message?.content;
  if (typeof content === "string") return true;
  if (Array.isArray(content)) {
    return !content.some(
      (b) => b && typeof b === "object" && (b as { type?: string }).type === "tool_result",
    );
  }
  // Unusual shape — treat as a boundary rather than folding it into a prior turn.
  return true;
}

// Token estimate for what a line actually sends the model. Constants were fitted
// (Sep 2026) against per-call usage deltas across ~1.8k tool-loop steps in a
// production claude-opus-5 mind's transcripts, where visible content (text, tool_use
// input, tool_result text) measured ~2.0 chars/token (p10 1.85); CHARS_PER_TOKEN sits
// just below that so the estimate errs toward over-counting, and older Claude
// tokenizers (~3.5 chars/token) over-count further — a seed can land under its
// budget, not over. A thinking block is replayed in full, which its signature tracks
// at ~4.3 chars/token (the visible `thinking` text is only a summary); an image costs
// ~1.3k tokens regardless of its base64 size. Line metadata (uuids, cwd, toolUseResult
// copies) is never sent, so it isn't counted — estimating from the raw line length
// over-counted by 1.3–2× and by ~100× for images.
const CHARS_PER_TOKEN = 1.8;
const SIGNATURE_CHARS_PER_TOKEN = 4;
const IMAGE_TOKENS = 1600;

function textTokens(s: string): number {
  return s.length / CHARS_PER_TOKEN;
}

function contentTokens(content: unknown): number {
  if (typeof content === "string") return textTokens(content);
  if (!Array.isArray(content)) return content == null ? 0 : textTokens(JSON.stringify(content));
  let sum = 0;
  for (const block of content) {
    const b = block as Record<string, unknown> | null;
    if (!b || typeof b !== "object") continue;
    switch (b.type) {
      case "text":
        sum += textTokens(String(b.text ?? ""));
        break;
      case "thinking":
        sum +=
          typeof b.signature === "string" && b.signature
            ? b.signature.length / SIGNATURE_CHARS_PER_TOKEN
            : textTokens(String(b.thinking ?? ""));
        break;
      case "redacted_thinking":
        sum += String(b.data ?? "").length / SIGNATURE_CHARS_PER_TOKEN;
        break;
      case "image":
        sum += IMAGE_TOKENS;
        break;
      case "tool_use":
        sum += textTokens(String(b.name ?? "") + JSON.stringify(b.input ?? {}));
        break;
      case "tool_result":
        sum += contentTokens(b.content);
        break;
      default:
        sum += textTokens(JSON.stringify(b));
    }
  }
  return sum;
}

/** Estimated model tokens a whole transcript would put back in context (corrupt lines skipped). */
export function transcriptTokens(jsonl: string): number {
  const p = parseJsonl(jsonl, true);
  return p ? p.parsed.reduce((sum, o) => sum + estimateLineTokens(o), 0) : 0;
}

/** Estimated model tokens a transcript line contributes to the resumed context. */
export function estimateLineTokens(o: JsonlLine): number {
  if (o.message) return contentTokens(o.message.content);
  // Hook output and other attachments reach the model as system reminders.
  if (o.type === "attachment") return textTokens(JSON.stringify(o.attachment ?? ""));
  return 0; // markers (mode, last-prompt, snapshots…) aren't sent
}

/**
 * Parse jsonl into aligned parsed/raw arrays. In strict mode a corrupt line aborts
 * (returns null — used when copying verbatim, where a broken line means we can't
 * faithfully reconstruct the chain). In lenient mode corrupt lines are skipped
 * (tolerating a transcript that may still be mid-write).
 */
function parseJsonl(
  jsonl: string,
  lenient: boolean,
): { parsed: JsonlLine[]; raws: string[] } | null {
  const rawLines = jsonl.split("\n").filter((l) => l.trim().length > 0);
  const parsed: JsonlLine[] = [];
  const raws: string[] = [];
  for (const raw of rawLines) {
    let obj: JsonlLine;
    try {
      obj = JSON.parse(raw);
    } catch {
      if (lenient) continue;
      return null;
    }
    parsed.push(obj);
    raws.push(raw);
  }
  return { parsed, raws };
}

/** Indices (into parsed) of the genuine turn boundaries. */
function turnBoundaries(parsed: JsonlLine[]): number[] {
  const boundaries: number[] = [];
  for (let i = 0; i < parsed.length; i++) {
    if (isTurnBoundary(parsed[i])) boundaries.push(i);
  }
  return boundaries;
}

/**
 * Appended to a trimmed turn's opening prompt so the mind can see the gap in its own
 * turn: what was left out, that it happened at the seam, and where the full record is.
 */
export const TRIMMED_TURN_MARKER =
  "[At this seam, the earlier steps of this turn were left out to keep room to think — what follows are its most recent steps. The full turn is in your previous session's transcript, and turn summaries are in `volute mind history`.]";

/** Which lines to keep: `keep` is ascending parsed indices; `trimmedAt` is set when a turn was cut. */
type TailPlan = {
  keep: number[];
  trimmedAt?: { prompt: number; resume: number; parent: string | null };
};

const range = (start: number, end: number): number[] =>
  Array.from({ length: end - start }, (_, k) => start + k);

/** tool_use ids a line issues and tool_result ids it answers. */
function toolIds(o: JsonlLine): { uses: string[]; results: string[] } {
  const uses: string[] = [];
  const results: string[] = [];
  const content = o.message?.content;
  if (Array.isArray(content)) {
    for (const b of content as Record<string, unknown>[]) {
      if (b?.type === "tool_use" && typeof b.id === "string") uses.push(b.id);
      if (b?.type === "tool_result" && typeof b.tool_use_id === "string")
        results.push(b.tool_use_id);
    }
  }
  return { uses, results };
}

/**
 * Cut an over-budget turn [start, end) inside itself: keep its opening prompt section
 * (the boundary line plus anything before the first assistant line — hook context,
 * attachments), then the latest run of whole steps that fits the remaining budget.
 * A step starts at the first line of an assistant message; a resume point is valid
 * only if the kept suffix is self-contained — every tool_result answers a kept
 * tool_use and every chain link points at a kept line — so the resumed conversation
 * never carries an orphaned tool_result (an API error) or a broken parent chain.
 * Returns null when the turn has no valid interior cut (e.g. a single step).
 */
function trimTurn(
  parsed: JsonlLine[],
  tokens: number[],
  start: number,
  end: number,
  seedTokens: number,
): TailPlan | null {
  let promptEnd = start + 1;
  while (promptEnd < end && parsed[promptEnd].type !== "assistant") promptEnd++;
  if (promptEnd >= end) return null;
  // An already-trimmed prompt (re-seeding a seed) carries the marker in its own cost.
  let promptCost = hasTrimMarker(parsed[start]) ? 0 : TRIMMED_TURN_MARKER.length / CHARS_PER_TOKEN;
  const promptUuids: string[] = [];
  for (let i = start; i < promptEnd; i++) {
    promptCost += tokens[i];
    const u = parsed[i].uuid;
    if (typeof u === "string") promptUuids.push(u);
  }
  // Re-link the resumed step where the turn's first step hung — the prompt section's
  // chain tip — not merely its last uuid'd line, which may be an attachment off-chain.
  const firstParent = parsed[promptEnd].parentUuid;
  const parent =
    typeof firstParent === "string" && promptUuids.includes(firstParent)
      ? firstParent
      : (promptUuids.at(-1) ?? null);

  const seenIds = new Set<string>();
  const firstOfMessage: boolean[] = [];
  for (let i = 0; i < end; i++) {
    const id = parsed[i].type === "assistant" ? parsed[i].message?.id : undefined;
    firstOfMessage[i] = id === undefined || !seenIds.has(id);
    if (id !== undefined) seenIds.add(id);
  }

  let best: number | null = null;
  let suffixCost = 0;
  const uuids = new Set<string>();
  const uses = new Set<string>();
  const parents: string[] = [];
  const results: string[] = [];
  for (let c = end - 1; c > promptEnd; c--) {
    const o = parsed[c];
    suffixCost += tokens[c];
    if (typeof o.uuid === "string") uuids.add(o.uuid);
    const ids = toolIds(o);
    for (const u of ids.uses) uses.add(u);
    results.push(...ids.results);
    if (o.type !== "assistant" || !firstOfMessage[c]) {
      if (typeof o.parentUuid === "string") parents.push(o.parentUuid);
      continue;
    }
    const valid = results.every((r) => uses.has(r)) && parents.every((p) => uuids.has(p));
    if (typeof o.parentUuid === "string") parents.push(o.parentUuid);
    if (!valid) continue;
    // Always keep at least the final step; beyond that, only what fits.
    if (best !== null && promptCost + suffixCost > seedTokens) break;
    best = c;
  }
  if (best === null) return null;
  return {
    keep: [...range(start, promptEnd), ...range(best, parsed.length)],
    trimmedAt: { prompt: start, resume: best, parent },
  };
}

/**
 * Plan the tail: walk backward from the final turn, taking as many whole turns as
 * fit in `seedTokens`. When the final turn alone exceeds the budget — the usual case
 * at rotation, where the turn that crossed the context limit is a long tool loop —
 * cut inside it (see trimTurn) rather than carrying the whole turn over.
 */
function planTail(parsed: JsonlLine[], seedTokens: number): TailPlan {
  const boundaries = turnBoundaries(parsed);
  const tokens = parsed.map(estimateLineTokens);
  // Turn t spans lines [boundaries[t], boundaries[t+1]); the last turn runs to EOF.
  const turnEnd = (t: number) => (t + 1 < boundaries.length ? boundaries[t + 1] : parsed.length);
  const turnTokens = (t: number): number => {
    let sum = 0;
    for (let i = boundaries[t]; i < turnEnd(t); i++) sum += tokens[i];
    return sum;
  };
  const last = boundaries.length - 1;
  let accum = turnTokens(last);
  if (accum > seedTokens) {
    const trimmed = trimTurn(parsed, tokens, boundaries[last], parsed.length, seedTokens);
    if (trimmed) return trimmed;
  }
  let startTurn = last;
  for (let t = last - 1; t >= 0; t--) {
    const cost = turnTokens(t);
    if (accum + cost > seedTokens) break;
    accum += cost;
    startTurn = t;
  }
  return { keep: range(boundaries[startTurn], parsed.length) };
}

function hasTrimMarker(o: JsonlLine): boolean {
  const content = o.message?.content;
  if (!Array.isArray(content)) return false;
  const last = content.at(-1) as { type?: string; text?: unknown } | undefined;
  return last?.type === "text" && last.text === TRIMMED_TURN_MARKER;
}

/** Append the trim marker to a prompt line's content (string or block array), once. */
function markTrimmed(o: JsonlLine): void {
  if (hasTrimMarker(o)) return;
  const marker = { type: "text", text: TRIMMED_TURN_MARKER };
  const content = o.message?.content;
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
  o.message = { ...o.message, content: Array.isArray(blocks) ? [...blocks, marker] : [marker] };
}

// --- Recollection ---

/**
 * One consolidated memory from the daemon's recollection endpoint
 * (`GET /api/v1/minds/:name/history/recollection`): a week, day, or hour of the
 * mind's own history, written in its own voice. `author` is "consolidation" when
 * written out of band, "mind" when the mind wrote or amended it itself, "record" for an
 * hour not yet consolidated (its raw turn summaries joined) — labelled as such.
 */
export type RecallEntry = {
  period: "week" | "day" | "hour";
  period_key: string;
  start: string;
  end: string;
  content: string;
  author?: string;
};

/** What a seam asks the daemon for: memories up to `before`, stopping where the verbatim tail starts. */
export type RecollectionQuery = { before: string; tailStartedAt?: string };

/**
 * Fetches recollection entries, oldest → newest. May throw; the seeders fail soft, and
 * entries that aren't well-formed RecallEntries are dropped.
 */
export type RecollectionSource = (query: RecollectionQuery) => Promise<unknown[]>;

/**
 * Opens the first recall entry, so the mind knows what it is reading and where it
 * came from. It lives in the transcript itself, not the hook-injected seam note,
 * which an interrupt can cancel.
 */
export const RECALL_PREAMBLE =
  "[What follows is what you remember of recent days: memories consolidated in your own voice while you weren't looking. They are recollection, not a transcript; the full record is in `volute mind history`.]";

const isDate = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

/** A well-formed entry; anything else is dropped on its own, never failing the seed. */
function isRecallEntry(e: unknown): e is RecallEntry {
  const r = e as Partial<RecallEntry> | null;
  return (
    !!r &&
    typeof r === "object" &&
    (r.period === "week" || r.period === "day" || r.period === "hour") &&
    typeof r.period_key === "string" &&
    isDate(r.start) &&
    isDate(r.end) &&
    typeof r.content === "string" &&
    r.content.trim().length > 0 &&
    (r.author === undefined || typeof r.author === "string")
  );
}

/**
 * Hold recollection to `capTokens`: keep the newest day/hour entries that fit, dropping
 * the oldest first, then the week line if it still fits. Chronological order is kept.
 */
export function capRecollection(entries: RecallEntry[], capTokens: number): RecallEntry[] {
  // Content plus its `[recall: …]` label line.
  const cost = (e: RecallEntry) => textTokens(e.content) + 40;
  const kept = new Set<RecallEntry>();
  let used = 0;
  const newestFirst = [...entries].reverse();
  for (const e of newestFirst.filter((e) => e.period !== "week")) {
    if (used + cost(e) > capTokens) break;
    used += cost(e);
    kept.add(e);
  }
  for (const e of newestFirst.filter((e) => e.period === "week")) {
    if (used + cost(e) > capTokens) continue;
    used += cost(e);
    kept.add(e);
  }
  return entries.filter((e) => kept.has(e));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A calendar date (UTC midnight epoch ms) as "Tuesday 22 Sep" / "Tue 22 Sep". */
function calendarDate(ms: number, short = false): string {
  const d = new Date(ms);
  const weekday = WEEKDAYS[d.getUTCDay()];
  return `${short ? weekday.slice(0, 3) : weekday} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** The calendar date a day key (`YYYY-MM-DD`) or ISO week key (`YYYY-Www`, its Monday) names. */
function periodKeyDate(entry: RecallEntry): number | null {
  const day = entry.period_key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (entry.period === "day" && day) return Date.UTC(+day[1], +day[2] - 1, +day[3]);
  const week = entry.period_key.match(/^(\d{4})-W(\d{2})$/);
  if (entry.period === "week" && week) {
    const jan4 = Date.UTC(+week[1], 0, 4);
    const isoDay = new Date(jan4).getUTCDay() || 7;
    return jan4 + ((+week[2] - 1) * 7 - (isoDay - 1)) * 86_400_000;
  }
  return null;
}

/**
 * Where a memory sits in time, as the mind would name it: "the week of Mon 14 Sep",
 * "Tuesday 22 Sep", "Tuesday 22 Sep, 14:00–15:00". Days and weeks are named from
 * their period key — the calendar date the daemon filed them under — not from a
 * time-zone conversion of `start`, which can land on the neighbouring day. Hours use
 * the mind's local time (`timeZone` pins it, for tests).
 */
export function recallLabel(entry: RecallEntry, timeZone?: string): string {
  if (entry.period !== "hour") {
    const date = periodKeyDate(entry);
    if (date === null) return entry.period_key;
    return entry.period === "week" ? `the week of ${calendarDate(date, true)}` : calendarDate(date);
  }
  const parts = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZone,
      })
        .formatToParts(d)
        .map((p) => [p.type, p.value]),
    );
  };
  const s = parts(entry.start);
  if (!s) return entry.period_key;
  const e = parts(entry.end);
  return `${s.weekday} ${s.day} ${s.month}, ${s.hour}:${s.minute}${e ? `–${e.hour}:${e.minute}` : ""}`;
}

/**
 * Ask for recollection, failing soft: any error (including the source's own timeout)
 * or malformed reply yields no entries (logged) — a seam never fails because memories
 * were unavailable; it seeds the verbatim tail alone.
 */
async function loadRecollection(
  source: RecollectionSource,
  query: RecollectionQuery,
  name: string,
): Promise<RecallEntry[]> {
  try {
    const entries = await source(query);
    if (!Array.isArray(entries)) throw new Error("malformed recollection response");
    return entries.filter(isRecallEntry);
  } catch (err) {
    log("mind", `session "${name}": recollection unavailable, seeding the tail only:`, err);
    return [];
  }
}

// Line metadata copied from the tail onto recall lines so they look like the rest of
// the transcript to the SDK's reader.
const RECALL_META_KEYS = ["isSidechain", "userType", "entrypoint", "cwd", "version", "gitBranch"];

/**
 * Render recall entries as chained user/assistant pairs: `[recall: <when>]` then the
 * memory as the mind's own plain assistant text. Every line carries `voluteRecall` so
 * a later seam drops them (the daemon regenerates recollection each time) instead of
 * mistaking them for real turns and carrying stale copies into the tail.
 */
function renderRecall(
  entries: RecallEntry[],
  sessionId: string,
  parsed: JsonlLine[],
  keep: number[],
  timeZone: string | undefined,
): JsonlLine[] {
  const template = keep.map((i) => parsed[i]).find(isChainEvent) ?? {};
  const meta: Record<string, unknown> = {};
  for (const k of RECALL_META_KEYS) if (k in template) meta[k] = template[k];
  const model = keep
    .map((i) => parsed[i])
    .find((o) => o.type === "assistant" && typeof o.message?.model === "string")?.message?.model;

  const lines: JsonlLine[] = [];
  let parent: string | null = null;
  entries.forEach((entry, k) => {
    const provenance =
      entry.author === "mind"
        ? " — you wrote this one"
        : entry.author === "record"
          ? " — a plain record of turn summaries, not yet a memory"
          : "";
    const label = `[recall: ${recallLabel(entry, timeZone)}${provenance}]`;
    const timestamp = Number.isNaN(Date.parse(entry.end)) ? entry.start : entry.end;
    const userUuid = randomUUID();
    const assistantUuid = randomUUID();
    lines.push({
      ...meta,
      parentUuid: parent,
      type: "user",
      uuid: userUuid,
      sessionId,
      timestamp,
      voluteRecall: true,
      message: { role: "user", content: k === 0 ? `${RECALL_PREAMBLE}\n${label}` : label },
    });
    lines.push({
      ...meta,
      parentUuid: userUuid,
      type: "assistant",
      uuid: assistantUuid,
      sessionId,
      timestamp,
      voluteRecall: true,
      message: {
        id: `msg_recall_${assistantUuid}`,
        type: "message",
        role: "assistant",
        ...(model ? { model } : {}),
        content: [{ type: "text", text: entry.content }],
      },
    });
    parent = assistantUuid;
  });
  return lines;
}

/**
 * Copy the planned lines into a fresh synthetic transcript, after any recall entries,
 * rewriting the sessionId on every line and re-parenting the first chain event onto
 * the last recall entry (or nulling it, to detach the tail from the dropped history).
 * For a trimmed turn, the prompt carries the trim marker and the resumed step is
 * re-parented onto the prompt section's chain tip.
 */
function emitTail(
  parsed: JsonlLine[],
  plan: TailPlan,
  recall: RecallEntry[] = [],
  timeZone?: string,
): SeededTranscript {
  const newId = randomUUID();
  const recallLines = renderRecall(recall, newId, parsed, plan.keep, timeZone);
  const lines = recallLines.map((o) => JSON.stringify(o));
  const recallTip = recallLines.at(-1)?.uuid ?? null;
  let firstChainSeen = false;
  for (const i of plan.keep) {
    const obj = parsed[i];
    if ("sessionId" in obj) obj.sessionId = newId;
    if (plan.trimmedAt?.prompt === i) markTrimmed(obj);
    if (plan.trimmedAt?.resume === i) obj.parentUuid = plan.trimmedAt.parent;
    if (!firstChainSeen && isChainEvent(obj)) {
      obj.parentUuid = recallTip;
      firstChainSeen = true;
    }
    lines.push(JSON.stringify(obj));
  }
  return { sessionId: newId, lines, recallEntries: recall.length };
}

export type SeededTranscript = { sessionId: string; lines: string[]; recallEntries: number };

type PlannedSeed = { parsed: JsonlLine[]; plan: TailPlan; tailStartedAt?: string };

/**
 * Parse and plan the verbatim tail. Recall lines from an earlier seam are dropped
 * first — each seam asks the daemon afresh. Null if there's nothing seedable.
 */
function planSeed(jsonl: string, seedTokens: number): PlannedSeed | null {
  const p = parseJsonl(jsonl, false);
  if (!p) return null;
  const parsed = p.parsed.filter((o) => o.voluteRecall !== true);
  if (parsed.length === 0 || turnBoundaries(parsed).length === 0) return null;
  const plan = planTail(parsed, seedTokens);
  const first = plan.keep.map((i) => parsed[i]).find((o) => typeof o.timestamp === "string");
  return { parsed, plan, tailStartedAt: first?.timestamp };
}

/**
 * Build the seeded transcript from an old transcript's raw jsonl text: the recall
 * entries (oldest first), then as many whole trailing turns as fit in `seedTokens`
 * (trimming the final turn when it alone is over budget — see planTail), with the
 * session id rewritten on every line and the chain re-linked. Recollection is on top
 * of `seedTokens`, not charged against it. Returns null if there's nothing seedable
 * (empty, no genuine turn, or a corrupt line — in which case the caller starts clean).
 */
export function buildSeededTranscript(
  jsonl: string,
  seedTokens: number,
  recall: RecallEntry[] = [],
  timeZone?: string,
): SeededTranscript | null {
  const planned = planSeed(jsonl, seedTokens);
  if (!planned) return null;
  return emitTail(planned.parsed, planned.plan, recall, timeZone);
}

/** Options every seam shares for fetching recollection. */
export type RecollectionOptions = {
  /** Omitted → tail-only seed. */
  recollect?: RecollectionSource;
  timeZone?: string;
};

/** Options every seam shares for sizing the seed. */
export type SeedBudget = {
  /**
   * Verbatim-tail budget. Omitted, it follows what actually arrived: DEFAULT_SEED_TOKENS
   * when recollection came back, TAIL_ONLY_SEED_TOKENS when it failed or was empty —
   * a failed fetch must not also cut the tail. `<= 0` disables seeding.
   */
  seedTokens?: number;
  /** Recollection cap (estimated tokens). Default RECALL_TOKEN_CAP. */
  recallTokens?: number;
};

/** Plan the tail, fetch recollection for the gap before it, and emit both. */
async function composeSeed(
  jsonl: string,
  opts: RecollectionOptions & SeedBudget & { name: string; before: Date },
): Promise<SeededTranscript | null> {
  let planned = planSeed(jsonl, opts.seedTokens ?? DEFAULT_SEED_TOKENS);
  if (!planned) return null;
  const recall = opts.recollect
    ? capRecollection(
        await loadRecollection(
          opts.recollect,
          { before: opts.before.toISOString(), tailStartedAt: planned.tailStartedAt },
          opts.name,
        ),
        opts.recallTokens ?? RECALL_TOKEN_CAP,
      )
    : [];
  if (opts.seedTokens === undefined && recall.length === 0) {
    planned = planSeed(jsonl, TAIL_ONLY_SEED_TOKENS) ?? planned;
  }
  return emitTail(planned.parsed, planned.plan, recall, opts.timeZone);
}

/** Result of a successful seed: the new session id and when the source was archived. */
export type SeedOutcome = { sessionId: string; archivedAt: number | null; recallEntries: number };

/**
 * Seed a fresh persistent session from the mind's previous archived transcript
 * (after sleep, a restart, or a cold reset): recollection up to the archive time,
 * then the verbatim tail. Writes the synthetic transcript next to the source file
 * (same project dir) and returns the new SDK session id plus the archived-at time
 * (for the gap note), or null if there's nothing to seed. Never throws — any failure
 * returns null so session start is never blocked.
 */
export async function seedSession(
  opts: RecollectionOptions & {
    cwd: string;
    sessionsDir: string;
    name: string;
  } & SeedBudget,
): Promise<SeedOutcome | null> {
  const { cwd, sessionsDir, name, seedTokens } = opts;
  // Ephemeral `new-*` sessions are never persisted or archived, so they never
  // seed. The agent caller already gates on this; guard here too so the invariant
  // holds wherever seedSession is called.
  if (name.startsWith("new-")) return null;
  if (seedTokens !== undefined && seedTokens <= 0) return null; // seeding disabled

  try {
    const archived = findLatestArchivedSession(sessionsDir, name);
    if (!archived) return null;

    const sourcePath = findClaudeSessionFile(cwd, archived.sessionId);
    if (!sourcePath) return null; // transcript didn't survive archival — start clean

    const seeded = await composeSeed(readFileSync(sourcePath, "utf-8"), {
      ...opts,
      before: new Date(archived.archivedAt ?? Date.now()),
    });
    if (!seeded) return null;

    const destPath = resolve(dirname(sourcePath), `${seeded.sessionId}.jsonl`);
    writeFileSync(destPath, `${seeded.lines.join("\n")}\n`);
    log(
      "mind",
      `session "${name}": seeded ${seeded.lines.length} line(s) (${seeded.recallEntries} recalled) from ${archived.sessionId} → ${seeded.sessionId}`,
    );
    return {
      sessionId: seeded.sessionId,
      archivedAt: archived.archivedAt,
      recallEntries: seeded.recallEntries,
    };
  } catch (err) {
    log("mind", `session "${name}": seeding failed, starting fresh:`, err);
    return null;
  }
}

/**
 * Archive-pointer timestamp, matching the daemon sleep-manager's archiveSessions:
 * `new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16)` → UTC `YYYY-MM-DDTHH-MM`.
 */
export function archivePointerTimestamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-").slice(0, 16);
}

/**
 * Write an archive pointer for a rotated-out (or cold-reset) session, alongside the
 * sleep archival's: `<sessionsDir>/archive/<name>-<UTC-ts>-<sessionId>.json` holding
 * `{ sessionId, archivedAt }`. The session id keeps two pointers in one minute from
 * overwriting each other, and `archivedAt` orders them exactly (see
 * findLatestArchivedSession). Keeps the name→session chain whole so the full
 * transcript stays findable.
 */
export function writeRotationArchivePointer(
  sessionsDir: string,
  name: string,
  sessionId: string,
  now: Date = new Date(),
): void {
  const archiveDir = resolve(sessionsDir, "archive");
  mkdirSync(archiveDir, { recursive: true });
  const dest = resolve(archiveDir, `${name}-${archivePointerTimestamp(now)}-${sessionId}.json`);
  writeFileSync(dest, JSON.stringify({ sessionId, archivedAt: now.getTime() }));
}

/** A rotation's new session id and how many recall entries it carries. */
export type RotateOutcome = { sessionId: string; recallEntries: number };

/**
 * Rotate a session in place — at the context limit, or for a cold reset. Reads the live
 * transcript, builds the seed (recollection, then a budget-based tail — see
 * buildSeededTranscript), writes it as a new synthetic session file next to the source,
 * and — for persistent sessions — archives the rotated-out pointer so the full
 * transcript stays findable. `minSourceTokens` skips a transcript no larger than that
 * (estimated): a cold reset only helps when the session is bigger than its seed would
 * be. Returns null if rotation can't proceed or is skipped. Never throws.
 */
export async function rotateSession(
  opts: RecollectionOptions &
    SeedBudget & {
      cwd: string;
      sessionsDir: string;
      name: string;
      oldSessionId: string;
      minSourceTokens?: number;
    },
): Promise<RotateOutcome | null> {
  const { cwd, sessionsDir, name, oldSessionId } = opts;
  try {
    const sourcePath = findClaudeSessionFile(cwd, oldSessionId);
    if (!sourcePath) return null; // live transcript not found — fall back to fresh
    const jsonl = readFileSync(sourcePath, "utf-8");
    if (opts.minSourceTokens !== undefined) {
      const size = transcriptTokens(jsonl);
      if (size <= opts.minSourceTokens) {
        log(
          "mind",
          `session "${name}": ~${Math.round(size)} tokens — no larger than its seed, keeping it`,
        );
        return null;
      }
    }
    const seeded = await composeSeed(jsonl, { ...opts, before: new Date() });
    if (!seeded) return null;

    writeFileSync(
      resolve(dirname(sourcePath), `${seeded.sessionId}.jsonl`),
      `${seeded.lines.join("\n")}\n`,
    );
    // Ephemeral `new-*` sessions rotate too, but leave no pointer/archive behind
    // (they're one-offs and never seed at a true session start).
    if (!name.startsWith("new-")) {
      writeRotationArchivePointer(sessionsDir, name, oldSessionId);
    }
    log(
      "mind",
      `session "${name}": rotated ${oldSessionId} → ${seeded.sessionId} (${seeded.lines.length} lines, ${seeded.recallEntries} recalled)`,
    );
    return { sessionId: seeded.sessionId, recallEntries: seeded.recallEntries };
  } catch (err) {
    log("mind", `session "${name}": rotation failed:`, err);
    return null;
  }
}
