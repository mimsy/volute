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
 * the first kept entry's `parentId` (nulled, to make the tail a clean root).
 *
 * Nothing here throws: any failure returns null so session start is never blocked.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { findPiSessionFile } from "./context-breakdown.js";
import { log } from "./logger.js";
import { parseArchiveTimestamp } from "./seed-note.js";
import { DEFAULT_SEED_TOKENS } from "./session-seed.js";

export { DEFAULT_SEED_TOKENS };

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
  message?: { role?: string };
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

/** Estimate tokens for a raw JSONL line as its JSON text length / 4. */
function estimateTokens(raw: string): number {
  return raw.length / 4;
}

/**
 * Parse pi jsonl into aligned parsed/raw arrays (header at index 0). In strict mode
 * a corrupt line aborts (returns null — used when copying verbatim, where a broken
 * line means we can't faithfully reconstruct the tail). In lenient mode corrupt
 * lines are skipped (used at warn time, when the live transcript may be mid-write).
 */
function parsePiJsonl(
  jsonl: string,
  lenient: boolean,
): { parsed: PiEntry[]; raws: string[] } | null {
  const rawLines = jsonl.split("\n").filter((l) => l.trim().length > 0);
  const parsed: PiEntry[] = [];
  const raws: string[] = [];
  for (const raw of rawLines) {
    let obj: PiEntry;
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

/** Indices (into entries) of the genuine turn boundaries (user-role messages). */
function turnBoundaries(entries: PiEntry[]): number[] {
  const boundaries: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (isTurnBoundary(entries[i])) boundaries.push(i);
  }
  return boundaries;
}

/**
 * Choose the first-kept entry index: walk backward from the final turn, taking as
 * many whole turns as fit in `seedTokens` (always at least the final turn even if
 * it alone exceeds the budget). Returns a boundary index, or -1 if there's no turn.
 */
function tailStartByBudget(entries: PiEntry[], entryRaws: string[], seedTokens: number): number {
  const boundaries = turnBoundaries(entries);
  if (boundaries.length === 0) return -1;
  // Turn t spans entries [boundaries[t], boundaries[t+1]); the last runs to EOF.
  const turnTokens = (t: number): number => {
    const start = boundaries[t];
    const end = t + 1 < boundaries.length ? boundaries[t + 1] : entries.length;
    let sum = 0;
    for (let i = start; i < end; i++) sum += estimateTokens(entryRaws[i]);
    return sum;
  };
  const last = boundaries.length - 1;
  let startTurn = last;
  let accum = turnTokens(last);
  for (let t = last - 1; t >= 0; t--) {
    const cost = turnTokens(t);
    if (accum + cost > seedTokens) break;
    accum += cost;
    startTurn = t;
  }
  return boundaries[startTurn];
}

export type SeededPiTranscript = { sessionId: string; lines: string[] };

/**
 * Emit the seeded transcript: a fresh header (new id, rewritten cwd, source recorded
 * as `parentSession`) followed by the tail from `startIdx` through EOF. The tail is
 * copied byte-for-byte from the original raw lines; only the first kept entry is
 * re-serialized, to null its parentId (detaching the tail into a clean root).
 */
function emitPiTail(
  header: PiHeader,
  entries: PiEntry[],
  entryRaws: string[],
  startIdx: number,
  cwd: string,
  sourcePath?: string,
): SeededPiTranscript {
  const newId = randomUUID();
  const newHeader: PiHeader = {
    type: "session",
    version: typeof header.version === "number" ? header.version : 3,
    id: newId,
    timestamp: new Date().toISOString(),
    cwd: resolve(cwd),
    ...(sourcePath ? { parentSession: sourcePath } : {}),
  };
  const lines: string[] = [JSON.stringify(newHeader)];
  for (let i = startIdx; i < entries.length; i++) {
    lines.push(i === startIdx ? JSON.stringify({ ...entries[i], parentId: null }) : entryRaws[i]);
  }
  return { sessionId: newId, lines };
}

/**
 * Build the seeded transcript from a source pi session file's raw jsonl text: take
 * as many whole trailing turns as fit in `seedTokens` (always at least the final
 * turn), keeping the tail entries verbatim. Returns null if there's nothing
 * seedable (no header, no genuine turn, or a corrupt line — start clean instead).
 */
export function buildSeededPiTranscript(
  jsonl: string,
  opts: { cwd: string; seedTokens: number; sourcePath?: string },
): SeededPiTranscript | null {
  const p = parsePiJsonl(jsonl, false);
  if (!p) return null;
  const h = splitPiHeader(p.parsed, p.raws);
  if (!h) return null;
  const startIdx = tailStartByBudget(h.entries, h.entryRaws, opts.seedTokens);
  if (startIdx < 0) return null;
  return emitPiTail(h.header, h.entries, h.entryRaws, startIdx, opts.cwd, opts.sourcePath);
}

/** A pinned cut point for rotation: where the verbatim tail begins. */
export type PiSeedCut = { boundaryId: string; boundaryTimestamp: string | null };

/**
 * Compute the cut point (the first-kept turn's identity) for a `seedTokens` budget,
 * from raw jsonl. Parsed leniently because the live transcript may still be mid-write
 * when this runs at warn time. Returns null if there's no genuine turn or the chosen
 * boundary entry lacks an id.
 */
export function computePiSeedCut(jsonl: string, seedTokens: number): PiSeedCut | null {
  const p = parsePiJsonl(jsonl, true);
  if (!p) return null;
  const h = splitPiHeader(p.parsed, p.raws);
  if (!h) return null;
  const startIdx = tailStartByBudget(h.entries, h.entryRaws, seedTokens);
  if (startIdx < 0) return null;
  const boundary = h.entries[startIdx];
  if (typeof boundary.id !== "string") return null;
  return {
    boundaryId: boundary.id,
    boundaryTimestamp: typeof boundary.timestamp === "string" ? boundary.timestamp : null,
  };
}

/**
 * Build the seeded transcript starting at a pinned boundary entry id (the whole tail
 * from that entry through EOF). Used by rotation to honor the cut point the mind was
 * warned about, regardless of how much the transcript grew after the warning.
 * Returns null if the boundary id isn't found or a line is corrupt.
 */
export function buildSeededPiTranscriptFromCut(
  jsonl: string,
  opts: { cwd: string; boundaryId: string; sourcePath?: string },
): SeededPiTranscript | null {
  const p = parsePiJsonl(jsonl, false);
  if (!p) return null;
  const h = splitPiHeader(p.parsed, p.raws);
  if (!h) return null;
  const startIdx = h.entries.findIndex((e) => e.id === opts.boundaryId);
  if (startIdx < 0) return null;
  return emitPiTail(h.header, h.entries, h.entryRaws, startIdx, opts.cwd, opts.sourcePath);
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

/** Result of a successful pi seed: the new session id and when the source was archived. */
export type SeededPiOutcome = { sessionId: string; archivedAt: number | null };

/**
 * Seed a fresh persistent pi session from the mind's previous archived transcript.
 * Writes the synthetic session file into `<piSessionsDir>/<name>/` and returns the
 * new session id (the header id continueRecent will adopt) plus the archived-at
 * time (for the gap note), or null if there's nothing to seed. Never throws — any
 * failure returns null so session start is never blocked.
 */
export function seedPiSession(opts: {
  cwd: string;
  piSessionsDir: string;
  name: string;
  seedTokens: number;
}): SeededPiOutcome | null {
  const { cwd, piSessionsDir, name, seedTokens } = opts;
  // Ephemeral `new-*` sessions are never persisted or archived, so they never
  // seed. The agent caller already gates on this; guard here too so the invariant
  // holds wherever seedPiSession is called.
  if (name.startsWith("new-")) return null;
  if (seedTokens <= 0) return null; // seeding disabled
  // A live session already exists — let continueRecent resume it, don't seed.
  if (hasLivePiSession(piSessionsDir, name)) return null;

  try {
    const archived = findLatestArchivedPiSession(piSessionsDir, name);
    if (!archived) return null;

    // findPiSessionFile picks the latest `.jsonl` in `<base>/<subdir>`; here the
    // subdir is the archived `<name>-<ts>` directory we just located.
    const sourcePath = findPiSessionFile(resolve(piSessionsDir, "archive"), basename(archived.dir));
    if (!sourcePath) return null; // no transcript survived archival — start clean

    const seeded = buildSeededPiTranscript(readFileSync(sourcePath, "utf-8"), {
      cwd,
      seedTokens,
      sourcePath,
    });
    if (!seeded) return null;

    const destDir = resolve(piSessionsDir, name);
    mkdirSync(destDir, { recursive: true });
    const fileTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destPath = resolve(destDir, `${fileTimestamp}_${seeded.sessionId}.jsonl`);
    writeFileSync(destPath, `${seeded.lines.join("\n")}\n`);
    log(
      "mind",
      `session "${name}": seeded ${seeded.lines.length - 1} entr(ies) from ${sourcePath} → ${seeded.sessionId}`,
    );
    return { sessionId: seeded.sessionId, archivedAt: archived.archivedAt };
  } catch (err) {
    log("mind", `session "${name}": seeding failed, starting fresh:`, err);
    return null;
  }
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

/**
 * Rotate a pi session in place at the context limit. Reads the live session file,
 * builds a seeded tail from the pinned `cut` (falling back to a budget-based tail
 * when the pin can't be honored), writes it as a new session file in the same live
 * dir, and — for persistent sessions — archives the rotated-out file so the full
 * transcript stays findable. Returns the new session file **path** (the caller
 * switches the running SessionManager to it), or null if rotation can't proceed
 * (the caller then falls back to a fresh session). Never throws.
 */
export function rotatePiSession(opts: {
  cwd: string;
  sessionsDir: string;
  name: string;
  sourcePath: string;
  cut: PiSeedCut | null;
  seedTokens: number;
}): string | null {
  const { cwd, sessionsDir, name, sourcePath, cut, seedTokens } = opts;
  try {
    const jsonl = readFileSync(sourcePath, "utf-8");
    // Honor the pinned boundary the mind was warned about; only fall back to a
    // budget-based tail if the pin can't be resolved (missing/renamed id).
    const seeded =
      (cut
        ? buildSeededPiTranscriptFromCut(jsonl, { cwd, boundaryId: cut.boundaryId, sourcePath })
        : null) ?? buildSeededPiTranscript(jsonl, { cwd, seedTokens, sourcePath });
    if (!seeded) return null;

    const liveDir = resolve(sessionsDir, name);
    mkdirSync(liveDir, { recursive: true });
    const fileTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destPath = resolve(liveDir, `${fileTimestamp}_${seeded.sessionId}.jsonl`);
    writeFileSync(destPath, `${seeded.lines.join("\n")}\n`);

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
      `session "${name}": rotated ${basename(sourcePath)} → ${seeded.sessionId} (${seeded.lines.length - 1} entries)`,
    );
    return destPath;
  } catch (err) {
    log("mind", `session "${name}": rotation failed:`, err);
    return null;
  }
}
