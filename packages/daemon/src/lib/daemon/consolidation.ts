/**
 * First-person consolidation: what turns a mind's hour/day/week/month rollups into its own
 * memory rather than a log about it.
 *
 * Two pieces live here, both used by the summarizer's per-mind rollups (never `_system`):
 *
 * - **The material.** Besides the period's child summaries, a mind's rollup is given its own
 *   outbound words verbatim — what it said is what carries its voice — and whatever it wrote in
 *   its journal and dreams in the period. Every input is bounded, so the per-call cost is too.
 * - **The writer.** The mind's own model writes the memory, and no other: when this daemon can't
 *   call that model, the rollup stays deterministic (see `completeAsMind`).
 *
 * Mind files are read with daemon privileges (root on system installs), so every read goes
 * through `resolveRealWithinBase`: a mind that symlinks `memory/journal/<date>.md` at a host file
 * must not get that file summarized back into its own history.
 */
import { constants } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { and, eq, gte, lt } from "drizzle-orm";
import {
  aiCompleteModelOutcome,
  BACKGROUND_COMPLETION_TIMEOUT_MS,
  type CompletionOptions,
  type CompletionOutcome,
  withDeadline,
} from "../ai-service.js";
import { getDb } from "../db.js";
import { resolveMindDir } from "../mind/registry.js";
import { mindHistory } from "../schema.js";
import log from "../util/logger.js";
import { resolveRealWithinBase, resolveWithinBase } from "../util/paths.js";
import {
  getTimeRange,
  getUtcTimeRange,
  parseUtcDateTime,
  type TimerPeriod,
} from "../util/period-keys.js";
import { getSpendBudget } from "./spend-budget.js";
import { mindModelId } from "./usage-pricing.js";

const cLog = log.child("consolidation");

/** A completion that also says which model wrote it and what it cost. */
export type Completion =
  | { status: "ok"; text: string; model?: string; costUsd?: number | null }
  | { status: "unconfigured" }
  | { status: "failed" }
  /** Not attempted: the mind is over its spend cap. Write the placeholder; heal it after reset. */
  | { status: "deferred" };

export type Complete = (systemPrompt: string, userMessage: string) => Promise<Completion>;

// ── Bounds ──
//
// The hour is the call that repeats, so it sets the daily cost. A typical hour is ~3–4k input
// tokens (SOUL.md ~2k of it); the caps below hold even a pathological one to ~10k.

/** Cap on SOUL.md in the system prompt. */
export const SOUL_MAX_CHARS = 8000;
/** Cap on the period's child summaries (turn summaries, hour or day memories). */
export const RECORD_MAX_CHARS = 20000;
/** Cap on the mind's own outbound words, per period. Week/month carry none (days already do). */
export const OWN_WORDS_MAX_CHARS: Record<TimerPeriod, number> = {
  hour: 4000,
  day: 8000,
  week: 0,
  month: 0,
};
/** Cap on journal + dream text, per period. Week/month carry none (days already do). */
export const WRITINGS_MAX_CHARS: Record<TimerPeriod, number> = {
  hour: 4000,
  day: 6000,
  week: 0,
  month: 0,
};

const CUT_MARKER = "[… truncated …]";

/** Truncate to at most `max` chars, the cut marker included. */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - CUT_MARKER.length - 1)).trimEnd()} ${CUT_MARKER}`;
}

/** Below this, a truncated entry says less than the omitted-entries marker does. */
const MIN_SHARE = 200;

/**
 * Split `budget` across entries of the given lengths: short entries keep everything, and what's
 * left is shared evenly among the long ones.
 */
function fairShares(lengths: number[], budget: number): number[] {
  const shares = new Array<number>(lengths.length);
  const order = lengths.map((_, i) => i).sort((a, b) => lengths[a] - lengths[b]);
  let remaining = budget;
  order.forEach((idx, k) => {
    const give = Math.max(0, Math.min(lengths[idx], Math.floor(remaining / (order.length - k))));
    shares[idx] = give;
    remaining -= give;
  });
  return shares;
}

/**
 * Join entries under a character budget, markers included. Over budget, long entries are
 * truncated to a fair share (a marked cut, never a silent one). Only when there are too many
 * entries for each to keep a readable slice is the middle dropped, with a marker saying how many,
 * so the model summarizes around the gap instead of interpolating across it.
 */
export function boundEntries(entries: string[], max: number, sep = "\n\n"): string {
  const full = entries.join(sep);
  if (full.length <= max || entries.length === 0) return full;

  const shares = fairShares(
    entries.map((e) => e.length),
    max - sep.length * (entries.length - 1),
  );
  const smallestCut = Math.min(...shares.filter((share, i) => share < entries[i].length));
  if (smallestCut >= MIN_SHARE) return entries.map((e, i) => cut(e, shares[i])).join(sep);

  const capped = entries.map((e) => cut(e, MIN_SHARE));
  const markerRoom = `[… ${entries.length} entries omitted …]`.length + sep.length;
  const half = Math.floor((max - markerRoom) / 2);
  const head: string[] = [];
  let used = 0;
  let i = 0;
  while (i < capped.length && used + capped[i].length + sep.length <= half) {
    used += capped[i].length + sep.length;
    head.push(capped[i++]);
  }
  const tail: string[] = [];
  used = 0;
  let j = capped.length - 1;
  while (j >= i && used + capped[j].length + sep.length <= half) {
    used += capped[j].length + sep.length;
    tail.unshift(capped[j--]);
  }
  const omitted = j - i + 1;
  if (omitted <= 0) return [...head, ...tail].join(sep);
  const marker = `[… ${omitted} entr${omitted === 1 ? "y" : "ies"} omitted …]`;
  return [...head, marker, ...tail].join(sep);
}

// ── Reading the mind's own files ──

/**
 * The mind's `home/`, as a real path. The mind dir's own location comes from the registry, but
 * `home` sits inside it and the mind can replace it — with a symlink to another mind's home, say.
 * So the base is the real mind dir plus a literal `home`, and readHomeFile refuses to read while
 * that path is anything but itself.
 */
export async function mindHome(mind: string): Promise<string> {
  return resolve(await realpath(await resolveMindDir(mind)), "home");
}

/**
 * Read a file under the mind's `home/` (a real path, from mindHome), contained and bounded. With
 * `modifiedSince`, a file last modified before then doesn't count. Anything missing, escaping, or unreadable reads as null —
 * this is optional context, never a reason to fail a rollup.
 *
 * The daemon reads as root and the mind owns every path component, so containment is proven on
 * the open file itself, not on a path that can change under us: open first (`O_NOFOLLOW` for the
 * last component, `O_NONBLOCK` so a planted FIFO can't hang the read), then resolve the path's
 * real location, require it inside `home/`, and require the open fd to be that very file (same
 * dev/ino), a regular file with a single link — a hard link would make a host file "inside".
 * `home` itself must still be its own real path, so a mind can't point it at another mind's home.
 * A symlink swapped into any component between the two steps fails the identity check.
 */
export async function readHomeFile(
  home: string,
  rel: string,
  maxChars: number,
  opts: {
    modifiedSince?: number;
    fromEnd?: boolean;
    /** Test seam: runs between open and verification, where a swap would land. */
    afterOpen?: () => Promise<void>;
  } = {},
): Promise<string | null> {
  const { modifiedSince, fromEnd } = opts;
  if (maxChars <= 0) return null;
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(
      resolveWithinBase(home, rel),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const st = await fh.stat();
    await opts.afterOpen?.();
    if ((await realpath(home)) !== home) return null;
    const real = await stat(await resolveRealWithinBase(home, rel));
    if (!st.isFile() || st.nlink !== 1 || st.dev !== real.dev || st.ino !== real.ino) return null;
    if (modifiedSince !== undefined && st.mtimeMs < modifiedSince) return null;

    // Read only what the cap can use (UTF-8 is at most 4 bytes a character).
    const want = Math.min(st.size, maxChars * 4);
    const buf = Buffer.alloc(want);
    const { bytesRead } = await fh.read(buf, 0, want, fromEnd ? st.size - want : 0);
    const text = buf.subarray(0, bytesRead).toString("utf8").trim();
    if (!text) return null;
    if (!fromEnd) return cut(text, maxChars);
    // The latest part: whatever was appended most recently. The cut start is marked, and may land
    // mid-character on the raw read, so the first (possibly broken) line goes too.
    if (want === st.size && text.length <= maxChars) return text;
    const tail = text.slice(-(maxChars - CUT_MARKER.length - 1));
    const nl = tail.indexOf("\n");
    return `${CUT_MARKER} ${(nl >= 0 ? tail.slice(nl + 1) : tail).trim()}`;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** The mind's SOUL.md, bounded. Missing or unreadable → "". */
export async function readMindSoul(mind: string): Promise<string> {
  try {
    return (await readHomeFile(await mindHome(mind), "SOUL.md", SOUL_MAX_CHARS)) ?? "";
  } catch {
    return "";
  }
}

/**
 * The period's own bounds, as the first line of a rollup's input. Server-local, like the period
 * key and every entry label, so how long and when can be read off the record rather than
 * guessed (#1145).
 */
export function periodBounds(period: TimerPeriod, periodKey: string): string {
  switch (period) {
    case "hour": {
      const next = String(Number(periodKey.slice(11)) + 1).padStart(2, "0");
      return `[this hour: ${periodKey.slice(0, 10)} ${periodKey.slice(11)}:00–${next}:00]`;
    }
    case "day":
      return `[this day: ${periodKey}]`;
    case "week": {
      const { start, end } = getTimeRange(periodKey, "week");
      return `[this week: ${start.slice(0, 10)} to ${end.slice(0, 10)}]`;
    }
    case "month":
      return `[this month: ${periodKey}]`;
  }
}

function hhmm(createdAt: string): string {
  const d = parseUtcDateTime(createdAt);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The mind's outbound messages in the period, verbatim, labeled with time and channel. */
export async function gatherOwnWords(
  mind: string,
  period: TimerPeriod,
  periodKey: string,
): Promise<string> {
  const max = OWN_WORDS_MAX_CHARS[period];
  if (max <= 0) return "";
  const { start, end } = getUtcTimeRange(periodKey, period);
  const db = await getDb();
  // `outbound` only: an echoed reply is recorded as both `text` and `outbound`, so taking both
  // would double every word.
  const rows = await db
    .select({
      channel: mindHistory.channel,
      content: mindHistory.content,
      created_at: mindHistory.created_at,
    })
    .from(mindHistory)
    .where(
      and(
        eq(mindHistory.mind, mind),
        eq(mindHistory.type, "outbound"),
        gte(mindHistory.created_at, start),
        lt(mindHistory.created_at, end),
      ),
    )
    .orderBy(mindHistory.id);
  const lines = rows
    .filter((r) => r.content?.trim())
    .map((r) => {
      const on = r.channel ? ` on ${r.channel}` : "";
      return `[said ${hhmm(r.created_at)}${on}] ${r.content!.trim()}`;
    });
  return boundEntries(lines, max);
}

/**
 * Journal and dream entries written in the period. Both are day-keyed files
 * (`memory/journal/YYYY-MM-DD.md`, `memory/dreams/YYYY-MM-DD*.md`), so a day takes that date's
 * files. An hour has no filename to go by — it takes that date's files when they've been modified
 * since the hour began, and reads the journal from its end (what was added last).
 */
export async function gatherWritings(
  mind: string,
  period: TimerPeriod,
  periodKey: string,
): Promise<string> {
  const max = WRITINGS_MAX_CHARS[period];
  if (max <= 0) return "";
  let home: string;
  try {
    home = await mindHome(mind);
  } catch {
    return "";
  }
  const date = periodKey.slice(0, 10);
  // An hour has no filename to go by. A day file untouched since the hour began holds nothing
  // written in it; one touched since may (an entry is often written just after the hour, too).
  const modifiedSince =
    period === "hour"
      ? parseUtcDateTime(getUtcTimeRange(periodKey, "hour").start).getTime()
      : undefined;

  let dreamNames: string[] = [];
  try {
    const dir = await resolveRealWithinBase(home, "memory/dreams");
    dreamNames = (await readdir(dir)).filter((n) => n.startsWith(date) && n.endsWith(".md")).sort();
  } catch {
    // No dreams directory (or one pointing outside home) — nothing to add.
  }
  // Split the budget up front, leaving room for each label, so the final bound doesn't have to
  // cut into a file — which would take the end of an hour's journal tail, the part it's for.
  const each = Math.max(200, Math.floor(max / (1 + dreamNames.length)) - 80);

  const entries: string[] = [];
  // The day's journal accumulates, so an hour wants what was added last — its tail.
  const journal = await readHomeFile(home, `memory/journal/${date}.md`, each, {
    modifiedSince,
    fromEnd: period === "hour",
  });
  if (journal) entries.push(`[journal ${date}]\n${journal}`);
  for (const name of dreamNames) {
    const dream = await readHomeFile(home, `memory/dreams/${name}`, each, { modifiedSince });
    if (dream) entries.push(`[dream ${name}]\n${dream}`);
  }
  return boundEntries(entries, max);
}

// ── Choosing the writer ──

/** Minds already told about, so an unusable model is logged once per daemon run, not per hour. */
const unusableLogged = new Set<string>();

export type CompleteAsMindDeps = {
  modelFor: (mind: string) => Promise<string | null>;
  withModel: (
    system: string,
    user: string,
    model: string,
    opts: CompletionOptions,
  ) => Promise<CompletionOutcome>;
  /** Record what a summary cost. Background spend: never the mind's own cap (see spend-budget). */
  recordCost: (costUsd: number | null) => void;
  /** Whether the mind (or the install) has spent its cap for this period. */
  overCap: (mind: string) => boolean;
  /** Per-attempt deadline; a hung completion counts as failed. */
  deadlineMs: number;
};

function isOverCap(mind: string): boolean {
  try {
    return getSpendBudget().checkBudget(mind).status === "exceeded";
  } catch {
    return false; // No spend budget running (startup, tests) — no cap to be over.
  }
}

function recordBackgroundCost(costUsd: number | null): void {
  try {
    getSpendBudget().recordBackgroundUsage(costUsd);
  } catch {
    // No spend budget running (startup, tests) — nothing to charge against.
  }
}

const defaultDeps: CompleteAsMindDeps = {
  modelFor: mindModelId,
  withModel: aiCompleteModelOutcome,
  recordCost: recordBackgroundCost,
  overCap: isOverCap,
  // The completion carries its own abort deadline; this is the backstop around the whole attempt.
  deadlineMs: BACKGROUND_COMPLETION_TIMEOUT_MS + 5_000,
};

/** One attempt, bounded: a hung or throwing completion counts as failed. */
async function attempt(p: Promise<CompletionOutcome>, ms: number): Promise<CompletionOutcome> {
  try {
    return await withDeadline(p, ms);
  } catch (err) {
    cLog.warn("summary attempt failed", log.errorData(err));
    return { status: "failed" };
  }
}

/**
 * Write a summary in a mind's voice with the mind's own model — every summary of a mind, from a
 * single turn to a month, and (under the spirit's name) the system's. No other model ever writes
 * one: when this daemon can't use the mind's model (unknown, not enabled in Settings, no
 * configured provider or credentials), the result is `unconfigured` and the caller writes its
 * deterministic fallback, so a mind's memory is never a mix of voices.
 *
 * Over the mind's (or the install's) spend cap the summary is deferred rather than billed. The
 * cost is background spend: it counts toward the install-wide cap, never the mind's own.
 *
 * `failed` vs `unconfigured` is kept for callers holding a retry budget: only `failed` spends it.
 */
export async function completeAsMind(
  mind: string,
  systemPrompt: string,
  userMessage: string,
  deps: CompleteAsMindDeps = defaultDeps,
): Promise<Completion> {
  // Spending past the host's limit on the mind's behalf isn't ours to do. Defer: the caller writes
  // a placeholder that the repair sweep heals once the cap resets.
  if (deps.overCap(mind)) return { status: "deferred" };

  const model = await deps.modelFor(mind).catch(() => null);
  if (!model) {
    logUnusable(mind, "its model could not be determined");
    return { status: "unconfigured" };
  }

  let costUsd: number | null | undefined;
  const out = await attempt(
    deps.withModel(systemPrompt, userMessage, model, {
      onCost: (c) => {
        costUsd = c;
        deps.recordCost(c);
      },
    }),
    deps.deadlineMs,
  );
  if (out.status === "ok") {
    return { status: "ok", text: out.text, model, ...(costUsd === undefined ? {} : { costUsd }) };
  }
  if (out.status === "unconfigured") {
    logUnusable(
      mind,
      `this daemon can't use its model (${model}: not enabled in Settings, or no configured provider for it)`,
    );
  }
  return out;
}

function logUnusable(mind: string, reason: string): void {
  const key = `${mind}|${reason}`;
  if (unusableLogged.has(key)) return;
  unusableLogged.add(key);
  cLog.warn(`${mind}'s summaries are running in basic (non-AI) mode: ${reason}`);
}
