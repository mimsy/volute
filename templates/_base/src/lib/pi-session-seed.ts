/**
 * Session seeding for the pi template.
 *
 * When a pi mind starts a fresh *persistent* session (its live
 * `.mind/pi-sessions/<name>/` directory was archived away on sleep, or never
 * existed), we seed the new session by copying the tail of the previous
 * session's transcript into a new session file. `SessionManager.continueRecent`
 * then resumes it natively, so the mind experiences the same conversation
 * continuing rather than waking into an empty context.
 *
 * Pi's session format differs from the Claude Agent SDK's:
 *
 *   - A file is a header line `{type:"session", version, id, timestamp, cwd, …}`
 *     followed by JSONL entries. Each entry has its own `id`/`parentId` forming a
 *     tree; the session id lives only in the header, not on every line.
 *   - Message entries are `{type:"message", id, parentId, timestamp, message}`
 *     where `message.role` is one of `user` / `assistant` / `toolResult` / `custom`.
 *     Tool results are their own role, so an incoming prompt is exactly a
 *     `user`-role message — that is the turn boundary.
 *   - `continueRecent(cwd, dir)` picks the most-recent `.jsonl` in `dir` **whose
 *     header cwd matches** `cwd`, so the seed header's cwd must be rewritten to the
 *     mind's home dir (as `importPiSession` already does for imports).
 *
 * The copy is verbatim: message/tool_use/tool_result/thinking entries survive
 * as-is, keeping their own ids. Only two things are rewritten — the header
 * (fresh id, correct cwd, new timestamp, source recorded as `parentSession`) and
 * the first kept entry's `parentId` (re-linked onto the recollection, or nulled to
 * make the tail a clean root). The exception is a final turn too large for the
 * budget on its own: it keeps its opening prompt, marked as trimmed, and its latest
 * whole steps, re-linked onto the prompt (the planner is shared with the claude
 * seeder — see planTail in session-seed.ts).
 *
 * When the caller passes a recollection source, the mind's recall entries go ahead
 * of the tail as `custom_message` entries (customType `volute-recall`). pi-coding-agent
 * (0.87.1) feeds a custom_message into context as a user-role message
 * (sessionEntryToContextMessages → convertToLlm), so a pi mind reads its memories as
 * text handed to it rather than as its own earlier replies, as a claude mind does.
 *
 * Nothing here throws: any failure resolves null so session start is never blocked.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { findPiSessionFile } from "./context-breakdown.js";
import { log } from "./logger.js";
import { parseArchiveTimestamp } from "./seed-note.js";
import {
  CHARS_PER_TOKEN,
  failSoftAsync,
  IMAGE_TOKENS,
  OPENAI_CHARS_PER_TOKEN,
  planTail,
  planWithRecollection,
  RECALL_PREAMBLE,
  type RecallEntry,
  type RecollectionOptions,
  recallHeading,
  recallTimestamp,
  type SeedBudget,
  type SeedLine,
  SIGNATURE_CHARS_PER_TOKEN,
  type TailPlan,
  TRIMMED_TURN_MARKER,
} from "./session-seed.js";

/** customType of the recall entries a seed writes ahead of the tail. */
export const RECALL_CUSTOM_TYPE = "volute-recall";

// Archived pi-session directories are named `<name>-<timestamp>`, where the
// timestamp is `new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16)` →
// `YYYY-MM-DDTHH-MM` (see archiveSessions in the daemon's sleep-manager).
// Matching the strict shape after the `<name>-` prefix disambiguates a `main`
// session from a `main-thread` one.
const ARCHIVE_DIR_SUFFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2})$/;

type PiHeader = {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
};

type PiEntry = Record<string, unknown> & {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  customType?: string;
  content?: unknown;
  summary?: unknown;
  replacement?: unknown;
  message?: { role?: string; content?: unknown; toolCallId?: unknown };
};

/** A resolved archive directory: its absolute path and when it was archived. */
export type ArchivedPiSession = { dir: string; archivedAt: number | null };

/**
 * Newest archived pi-session directory for `<name>` under `<piSessionsDir>/archive/`,
 * or null if there's no matching directory. `dir` is the absolute path;
 * `archivedAt` is the archive timestamp in epoch millis (null if unparseable).
 */
export function findLatestArchivedPiSession(
  piSessionsDir: string,
  name: string,
): ArchivedPiSession | null {
  const archiveDir = resolve(piSessionsDir, "archive");
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(archiveDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const prefix = `${name}-`;
  let bestTs = "";
  let bestDir: string | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const match = entry.name.slice(prefix.length).match(ARCHIVE_DIR_SUFFIX);
    if (!match) continue;
    // Timestamps are zero-padded ISO, so lexicographic comparison is chronological.
    if (match[1] > bestTs) {
      bestTs = match[1];
      bestDir = entry.name;
    }
  }
  if (!bestDir) return null;
  return { dir: resolve(archiveDir, bestDir), archivedAt: parseArchiveTimestamp(bestTs) };
}

/** A turn boundary is a genuine incoming prompt: a `user`-role message entry. */
function isTurnBoundary(entry: PiEntry): boolean {
  return entry.type === "message" && entry.message?.role === "user";
}

// What an entry sends the model. pi-ai drives any provider, so the estimate follows the
// model the mind is on: the caller's resume model when given, else the transcript's
// latest model change or reply. For an Anthropic model (or when nothing tells), claude's
// fitted 1.8 chars/token (see session-seed.ts), with thinking counted by its signature,
// which the API replays. Otherwise OPENAI_CHARS_PER_TOKEN — measured on OpenAI models
// only; other providers' tokenizers (~4 chars/token for English) are assumed no denser —
// and thinking by its text: pi-ai's OpenAI `thinkingSignature` is the whole reasoning
// item, base64 `encrypted_content` included, whose length is nothing like its cost.
// Entries pi keeps out of context (model/thinking-level changes, labels, plain `custom`
// state, session info) cost nothing.
export type PiRate = { charsPerToken: number; signatures: boolean };

const ANTHROPIC_RATE: PiRate = { charsPerToken: CHARS_PER_TOKEN, signatures: true };
const OTHER_RATE: PiRate = { charsPerToken: OPENAI_CHARS_PER_TOKEN, signatures: false };

const rateFor = (model: string): PiRate =>
  /anthropic|claude/i.test(model) ? ANTHROPIC_RATE : OTHER_RATE;

/** The rate for `model` (e.g. "openai/gpt-5.5"), else for the transcript's latest model. */
function piRate(entries: PiEntry[], model?: string): PiRate {
  if (model) return rateFor(model);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as PiEntry & { provider?: unknown; modelId?: unknown };
    if (e.type === "model_change") return rateFor(`${e.provider ?? ""} ${e.modelId ?? ""}`);
    const m = e.message as { role?: string; provider?: unknown; model?: unknown } | undefined;
    if (e.type === "message" && m?.role === "assistant") {
      return rateFor(`${m.provider ?? ""} ${m.model ?? ""}`);
    }
  }
  return ANTHROPIC_RATE;
}

function blocksTokens(content: unknown, rate: PiRate): number {
  const text = (s: string) => s.length / rate.charsPerToken;
  if (typeof content === "string") return text(content);
  if (!Array.isArray(content)) return content == null ? 0 : text(JSON.stringify(content));
  let sum = 0;
  for (const block of content) {
    const b = block as Record<string, unknown> | null;
    if (!b || typeof b !== "object") continue;
    switch (b.type) {
      case "text":
        sum += text(String(b.text ?? ""));
        break;
      case "thinking":
        // Anthropic replays thinking by its signature (the visible text may be a summary,
        // or empty when redacted).
        sum +=
          rate.signatures && typeof b.thinkingSignature === "string" && b.thinkingSignature
            ? b.thinkingSignature.length / SIGNATURE_CHARS_PER_TOKEN
            : text(String(b.thinking ?? ""));
        break;
      case "image":
        sum += IMAGE_TOKENS;
        break;
      case "toolCall":
        sum += text(String(b.name ?? "") + JSON.stringify(b.arguments ?? {}));
        break;
      default:
        sum += text(JSON.stringify(b));
    }
  }
  return sum;
}

/**
 * Estimated model tokens an entry contributes to the resumed context, at `rate` (default:
 * an Anthropic model's — the densest, so an over-count elsewhere).
 */
export function estimatePiEntryTokens(entry: PiEntry, rate: PiRate = ANTHROPIC_RATE): number {
  const cpt = rate.charsPerToken;
  switch (entry.type) {
    case "message": {
      const m = entry.message as Record<string, unknown> | undefined;
      // A `!command` run: sent as its command and output, unless excluded (`!!`).
      if (m?.role === "bashExecution") {
        return m.excludeFromContext
          ? 0
          : (String(m.command ?? "") + String(m.output ?? "")).length / cpt;
      }
      return m?.content === undefined
        ? JSON.stringify(m ?? {}).length / cpt
        : blocksTokens(m.content, rate);
    }
    case "custom_message":
      return blocksTokens(entry.content, rate);
    case "compaction":
    case "branch_summary":
      return typeof entry.summary === "string" ? entry.summary.length / cpt : 0;
    case "context_edit":
      // Replaces its target's content; the target is still counted at its own size, so
      // this over-counts.
      return blocksTokens((entry.replacement as { content?: unknown } | null)?.content, rate);
    default:
      return 0;
  }
}

/**
 * Parse pi jsonl into aligned parsed/raw arrays (header at index 0). A corrupt line
 * aborts (returns null — a broken line means we can't faithfully reconstruct the tail).
 */
function parsePiJsonl(jsonl: string): { parsed: PiEntry[]; raws: string[] } | null {
  const rawLines = jsonl.split("\n").filter((l) => l.trim().length > 0);
  const parsed: PiEntry[] = [];
  const raws: string[] = [];
  for (const raw of rawLines) {
    try {
      parsed.push(JSON.parse(raw));
    } catch {
      return null;
    }
    raws.push(raw);
  }
  return { parsed, raws };
}

/**
 * Split a parsed transcript into its header and the entries after it (with aligned
 * raw lines). Returns null if the first line isn't a valid session header — pi
 * rejects files whose first line isn't `{type:"session", id, …}`.
 */
function splitPiHeader(
  parsed: PiEntry[],
  raws: string[],
): { header: PiHeader; entries: PiEntry[]; entryRaws: string[] } | null {
  const header = parsed[0] as PiHeader | undefined;
  if (header?.type !== "session" || typeof header.id !== "string") return null;
  return { header, entries: parsed.slice(1), entryRaws: raws.slice(1) };
}

function hasTrimMarker(entry: PiEntry): boolean {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return false;
  const last = content.at(-1) as { type?: string; text?: unknown } | undefined;
  return last?.type === "text" && last.text === TRIMMED_TURN_MARKER;
}

/** Map pi entries onto the shared planner's lines: a step starts at each assistant message. */
function toSeedLines(entries: PiEntry[], rate: PiRate): SeedLine[] {
  return entries.map((e) => {
    const uses: string[] = [];
    const results: string[] = [];
    const role = e.type === "message" ? e.message?.role : undefined;
    if (role === "assistant" && Array.isArray(e.message?.content)) {
      for (const b of e.message.content as Record<string, unknown>[]) {
        if (b?.type === "toolCall" && typeof b.id === "string") uses.push(b.id);
      }
    }
    if (role === "toolResult" && typeof e.message?.toolCallId === "string") {
      results.push(e.message.toolCallId);
    }
    return {
      tokens: estimatePiEntryTokens(e, rate),
      boundary: isTurnBoundary(e),
      stepStart: role === "assistant",
      id: typeof e.id === "string" ? e.id : undefined,
      parent: e.parentId,
      uses,
      results,
      marked: hasTrimMarker(e),
    };
  });
}

/** Append the trim marker to a prompt entry's content (string or block array), once. */
function markTrimmed(entry: PiEntry): PiEntry {
  if (hasTrimMarker(entry)) return entry;
  const marker = { type: "text", text: TRIMMED_TURN_MARKER };
  const content = entry.message?.content;
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
  return {
    ...entry,
    message: { ...entry.message, content: Array.isArray(blocks) ? [...blocks, marker] : [marker] },
  };
}

/**
 * Render recall entries as a chain of `custom_message` entries, the first opening
 * with RECALL_PREAMBLE. Hidden from any display (`display: false`); the model sees
 * them. Returns the entries and the id the tail should hang from.
 */
function renderPiRecall(
  recall: RecallEntry[],
  timeZone: string | undefined,
): { lines: string[]; tip: string | null } {
  const lines: string[] = [];
  let parent: string | null = null;
  recall.forEach((entry, k) => {
    const id = randomUUID();
    const heading = recallHeading(entry, timeZone);
    lines.push(
      JSON.stringify({
        type: "custom_message",
        customType: RECALL_CUSTOM_TYPE,
        content: `${k === 0 ? `${RECALL_PREAMBLE}\n` : ""}${heading}\n${entry.content}`,
        display: false,
        id,
        parentId: parent,
        timestamp: recallTimestamp(entry),
      }),
    );
    parent = id;
  });
  return { lines, tip: parent };
}

export type SeededPiTranscript = { sessionId: string; lines: string[]; recallEntries: number };

/** A parsed transcript with its planner lines, ready to plan at any budget. */
type SeedablePi = {
  header: PiHeader;
  entries: PiEntry[];
  entryRaws: string[];
  lines: SeedLine[];
  rate: PiRate;
};

type PlannedPiSeed = SeedablePi & {
  plan: TailPlan;
  tailStartedAt?: string;
  charsPerToken: number;
};

/**
 * Parse a transcript and estimate its lines at the rate for `model` (else the
 * transcript's own). Recall entries an earlier seam wrote sit ahead of its first
 * prompt, and a tail starts at a prompt, so they are never carried over: each seam asks
 * the daemon afresh.
 */
function readPiSeed(jsonl: string, model?: string): SeedablePi | null {
  const p = parsePiJsonl(jsonl);
  if (!p) return null;
  const h = splitPiHeader(p.parsed, p.raws);
  if (!h) return null;
  const rate = piRate(h.entries, model);
  return { ...h, lines: toSeedLines(h.entries, rate), rate };
}

/** Plan the tail at a budget. Null if there's nothing seedable. */
function planPiSeed(r: SeedablePi, seedTokens: number): PlannedPiSeed | null {
  const cpt = r.rate.charsPerToken;
  const plan = planTail(r.lines, seedTokens, TRIMMED_TURN_MARKER.length / cpt);
  if (!plan) return null;
  const first = plan.keep.map((i) => r.entries[i]).find((e) => typeof e.timestamp === "string");
  return { ...r, plan, tailStartedAt: first?.timestamp, charsPerToken: cpt };
}

/**
 * Emit the seeded transcript: a fresh header (new id, rewritten cwd, source recorded
 * as `parentSession`), any recall entries, then the planned tail. Kept entries are
 * copied byte-for-byte except the few that are rewritten: the first (re-parented
 * onto the recollection, or nulled to make the tail a clean root) and, for a trimmed
 * turn, its prompt (carrying the marker) and resumed step (re-parented onto the
 * prompt section's tip).
 */
function emitPiSeed(
  planned: PlannedPiSeed,
  opts: { cwd: string; sourcePath?: string; recall?: RecallEntry[]; timeZone?: string },
): SeededPiTranscript {
  const { header, entries, entryRaws, plan } = planned;
  const newId = randomUUID();
  const newHeader: PiHeader = {
    type: "session",
    version: typeof header.version === "number" ? header.version : 3,
    id: newId,
    timestamp: new Date().toISOString(),
    cwd: resolve(opts.cwd),
    ...(opts.sourcePath ? { parentSession: opts.sourcePath } : {}),
  };
  const recall = renderPiRecall(opts.recall ?? [], opts.timeZone);
  const lines: string[] = [JSON.stringify(newHeader), ...recall.lines];
  plan.keep.forEach((i, k) => {
    let entry = entries[i];
    let changed = false;
    if (plan.trimmedAt?.prompt === i) {
      entry = markTrimmed(entry);
      changed = true;
    }
    if (plan.trimmedAt?.resume === i) {
      entry = { ...entry, parentId: plan.trimmedAt.parent };
      changed = true;
    }
    if (k === 0) {
      entry = { ...entry, parentId: recall.tip };
      changed = true;
    }
    lines.push(changed ? JSON.stringify(entry) : entryRaws[i]);
  });
  return { sessionId: newId, lines, recallEntries: recall.lines.length };
}

/**
 * Build the seeded transcript from a source pi session file's raw jsonl text: any
 * recall entries, then as many whole trailing turns as fit in `seedTokens` (trimming
 * the final turn when it alone is over budget — see planTail), kept verbatim. Returns
 * null if there's nothing seedable (no header, no genuine turn, or a corrupt line —
 * start clean instead).
 */
export function buildSeededPiTranscript(
  jsonl: string,
  opts: {
    cwd: string;
    seedTokens: number;
    sourcePath?: string;
    recall?: RecallEntry[];
    timeZone?: string;
    model?: string;
  },
): SeededPiTranscript | null {
  const r = readPiSeed(jsonl, opts.model);
  const planned = r && planPiSeed(r, opts.seedTokens);
  return planned ? emitPiSeed(planned, opts) : null;
}

/**
 * Plan and emit a seed, fetching recollection first when the caller supplies a source
 * (see planWithRecollection — the budget and fail-soft rules are claude's).
 */
async function composePiSeed(
  jsonl: string,
  opts: RecollectionOptions &
    SeedBudget & {
      cwd: string;
      sourcePath?: string;
      name: string;
      before: Date;
      model?: string;
    },
): Promise<SeededPiTranscript | null> {
  const r = readPiSeed(jsonl, opts.model);
  if (!r) return null;
  const composed = await planWithRecollection((budget) => planPiSeed(r, budget), opts);
  if (!composed) return null;
  return emitPiSeed(composed.planned, { ...opts, recall: composed.recall });
}

/**
 * True if `<piSessionsDir>/<name>/` already holds a live pi `.jsonl` session —
 * in which case continueRecent will resume it and we must not seed over it.
 */
export function hasLivePiSession(piSessionsDir: string, name: string): boolean {
  try {
    return readdirSync(resolve(piSessionsDir, name)).some((f) => f.endsWith(".jsonl"));
  } catch {
    return false;
  }
}

/**
 * Result of a successful pi seed: the new session id, when the source was archived,
 * and how many recall entries went ahead of the tail.
 */
export type SeededPiOutcome = {
  sessionId: string;
  archivedAt: number | null;
  recallEntries: number;
};

/** `model` is the one the mind will resume on (e.g. "openai/gpt-5.5"); it sets the estimate's rate. */
type SeedPiOptions = {
  cwd: string;
  piSessionsDir: string;
  name: string;
  model?: string;
};

/** Where a seed comes from: the newest archived transcript for `name`. */
function findPiSeedSource(opts: {
  piSessionsDir: string;
  name: string;
  seedTokens?: number;
}): { sourcePath: string; archivedAt: number | null } | null {
  const { piSessionsDir, name, seedTokens } = opts;
  // Ephemeral `new-*` sessions are never persisted or archived, so they never
  // seed. The agent caller already gates on this; guard here too so the invariant
  // holds wherever seedPiSession is called.
  if (name.startsWith("new-")) return null;
  if (seedTokens !== undefined && seedTokens <= 0) return null; // seeding disabled
  // A live session already exists — let continueRecent resume it, don't seed.
  if (hasLivePiSession(piSessionsDir, name)) return null;
  const archived = findLatestArchivedPiSession(piSessionsDir, name);
  if (!archived) return null;
  // findPiSessionFile picks the latest `.jsonl` in `<base>/<subdir>`; here the
  // subdir is the archived `<name>-<ts>` directory we just located.
  const sourcePath = findPiSessionFile(resolve(piSessionsDir, "archive"), basename(archived.dir));
  if (!sourcePath) return null; // no transcript survived archival — start clean
  return { sourcePath, archivedAt: archived.archivedAt };
}

/** Write a seed into `<dir>/` under pi's `<timestamp>_<id>.jsonl` naming; returns its path. */
function writePiSeed(dir: string, seeded: SeededPiTranscript): string {
  mkdirSync(dir, { recursive: true });
  const fileTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destPath = resolve(dir, `${fileTimestamp}_${seeded.sessionId}.jsonl`);
  writeFileSync(destPath, `${seeded.lines.join("\n")}\n`);
  return destPath;
}

function seededPi(
  opts: { piSessionsDir: string; name: string },
  source: { sourcePath: string; archivedAt: number | null },
  seeded: SeededPiTranscript | null,
): SeededPiOutcome | null {
  if (!seeded) return null;
  writePiSeed(resolve(opts.piSessionsDir, opts.name), seeded);
  log(
    "mind",
    `session "${opts.name}": seeded ${seeded.lines.length - 1} entr(ies) (${seeded.recallEntries} recalled) from ${source.sourcePath} → ${seeded.sessionId}`,
  );
  return {
    sessionId: seeded.sessionId,
    archivedAt: source.archivedAt,
    recallEntries: seeded.recallEntries,
  };
}

/**
 * Seed a fresh persistent pi session from the mind's previous archived transcript: the
 * mind's recollection up to the archive time (when `recollect` is given — see
 * composePiSeed), then the tail. Writes the synthetic session file into
 * `<piSessionsDir>/<name>/` and resolves to the new session id (the header id
 * continueRecent will adopt), the archived-at time (for the gap note) and the recall
 * count, or null if there's nothing to seed. Never rejects — any failure resolves null
 * so session start is never blocked.
 */
export function seedPiSession(
  opts: SeedPiOptions & RecollectionOptions & SeedBudget,
): Promise<SeededPiOutcome | null> {
  return failSoftAsync(
    async () => {
      const source = findPiSeedSource(opts);
      if (!source) return null;
      const jsonl = readFileSync(source.sourcePath, "utf-8");
      const before = new Date(source.archivedAt ?? Date.now());
      const seeded = await composePiSeed(jsonl, {
        ...opts,
        sourcePath: source.sourcePath,
        before,
      });
      return seededPi(opts, source, seeded);
    },
    (err) => log("mind", `session "${opts.name}": seeding failed, starting fresh:`, err),
  );
}

/**
 * Archive-directory timestamp for a rotated-out pi session, matching the daemon
 * sleep-manager's archiveSessions: `toISOString().replace(/[:.]/g,"-").slice(0,16)`
 * → UTC `YYYY-MM-DDTHH-MM`.
 */
export function archivePiSessionTimestamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-").slice(0, 16);
}

/**
 * Relocate the rotated-out session file into `<piSessionsDir>/archive/<name>-<ts>/`,
 * mirroring how sleep archival preserves pi sessions (a `<name>-<ts>/` directory of
 * jsonl files — pi archives whole directories, not pointer files). Keeps the full
 * transcript findable and leaves the live dir holding only the new session.
 */
function archiveRotatedPiFile(
  piSessionsDir: string,
  name: string,
  sourcePath: string,
  now: Date = new Date(),
): void {
  const dest = resolve(piSessionsDir, "archive", `${name}-${archivePiSessionTimestamp(now)}`);
  mkdirSync(dest, { recursive: true });
  renameSync(sourcePath, resolve(dest, basename(sourcePath)));
}

type RotatePiOptions = {
  cwd: string;
  sessionsDir: string;
  name: string;
  sourcePath: string;
  /** The model the mind is on; it sets the estimate's rate. */
  model?: string;
};

/** A rotation with recollection: the new session file's path and how many recall entries it carries. */
export type RotatedPiOutcome = { path: string; recallEntries: number };

/** Write the rotated seed into the live dir and archive the rotated-out file; returns the new path. */
function adoptRotatedPi(opts: RotatePiOptions, seeded: SeededPiTranscript): string {
  const { sessionsDir, name, sourcePath } = opts;
  const destPath = writePiSeed(resolve(sessionsDir, name), seeded);
  // Archive the rotated-out session (mirrors sleep archival's dir layout). A
  // failure here is non-fatal — the new file is already live; the stale old file
  // just lingers (continueRecent still picks the newer one). Ephemeral `new-*`
  // sessions never reach here (they're inMemory, with no source file).
  if (!name.startsWith("new-")) {
    try {
      archiveRotatedPiFile(sessionsDir, name, sourcePath);
    } catch (err) {
      log("mind", `session "${name}": archiving rotated-out file failed:`, err);
    }
  }
  log(
    "mind",
    `session "${name}": rotated ${basename(sourcePath)} → ${seeded.sessionId} (${seeded.lines.length - 1} entries, ${seeded.recallEntries} recalled)`,
  );
  return destPath;
}

/**
 * Rotate a pi session in place at the context limit. Reads the live session file, builds
 * the mind's recollection (when `recollect` is given) and a budget-based tail (as many
 * whole trailing turns as fit, trimming an over-budget final turn), writes it as a new
 * session file in the same live dir, and — for persistent sessions — archives the
 * rotated-out file so the full transcript stays findable. Resolves to the new session
 * file's path (the caller switches the running SessionManager to it) and its recall
 * count, or null if rotation can't proceed (the caller then falls back to a fresh
 * session). Never rejects.
 *
 * The caller must hold the session quiet across the await: the live transcript is read
 * before it, so anything appended while recollection loads never reaches the new session
 * (the claude agent drops its query before awaiting, for the same reason).
 */
export function rotatePiSession(
  opts: RotatePiOptions & RecollectionOptions & SeedBudget,
): Promise<RotatedPiOutcome | null> {
  return failSoftAsync(
    async () => {
      const jsonl = readFileSync(opts.sourcePath, "utf-8");
      const seeded = await composePiSeed(jsonl, { ...opts, before: new Date() });
      if (!seeded) return null;
      return { path: adoptRotatedPi(opts, seeded), recallEntries: seeded.recallEntries };
    },
    (err) => log("mind", `session "${opts.name}": rotation failed:`, err),
  );
}
