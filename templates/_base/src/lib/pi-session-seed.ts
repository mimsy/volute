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
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { findPiSessionFile } from "./context-breakdown.js";
import { log } from "./logger.js";
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
  message?: { role?: string };
};

/**
 * Absolute path of the newest archived pi-session directory for `<name>` under
 * `<piSessionsDir>/archive/`, or null if there's no matching directory.
 */
export function findLatestArchivedPiSessionDir(piSessionsDir: string, name: string): string | null {
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
  return bestDir ? resolve(archiveDir, bestDir) : null;
}

/** A turn boundary is a genuine incoming prompt: a `user`-role message entry. */
function isTurnBoundary(entry: PiEntry): boolean {
  return entry.type === "message" && entry.message?.role === "user";
}

/** Estimate tokens for a raw JSONL line as its JSON text length / 4. */
function estimateTokens(raw: string): number {
  return raw.length / 4;
}

export type SeededPiTranscript = { sessionId: string; lines: string[] };

/**
 * Build the seeded transcript from a source pi session file's raw jsonl text:
 * take as many whole trailing turns as fit in `seedTokens` (always at least the
 * final turn), keeping the tail entries verbatim; then prepend a fresh header
 * (new id, `cwd`, source recorded as `parentSession`) and null the first kept
 * entry's parentId. Returns null if there's nothing seedable (no header, no
 * genuine turn, or a corrupt line — in which case the caller starts clean).
 */
export function buildSeededPiTranscript(
  jsonl: string,
  opts: { cwd: string; seedTokens: number; sourcePath?: string },
): SeededPiTranscript | null {
  const rawLines = jsonl.split("\n").filter((l) => l.trim().length > 0);
  if (rawLines.length === 0) return null;

  const parsed: PiEntry[] = [];
  for (const raw of rawLines) {
    try {
      parsed.push(JSON.parse(raw));
    } catch {
      // A corrupt line means we can't faithfully reconstruct the tree — start
      // clean rather than seed a broken transcript.
      return null;
    }
  }

  // First line must be a valid session header (pi rejects files otherwise).
  const header = parsed[0];
  if (header.type !== "session" || typeof header.id !== "string") return null;

  // Entries are everything after the header; keep raws aligned for cost estimates.
  const entries = parsed.slice(1);
  const entryRaws = rawLines.slice(1);

  const boundaries: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (isTurnBoundary(entries[i])) boundaries.push(i);
  }
  if (boundaries.length === 0) return null;

  // Turn t spans entries [boundaries[t], boundaries[t+1]); the last runs to EOF.
  const turnTokens = (t: number): number => {
    const start = boundaries[t];
    const end = t + 1 < boundaries.length ? boundaries[t + 1] : entries.length;
    let sum = 0;
    for (let i = start; i < end; i++) sum += estimateTokens(entryRaws[i]);
    return sum;
  };

  // Walk backward from the final turn, adding earlier whole turns while they fit.
  // The final turn is always included even if it alone exceeds the budget.
  const last = boundaries.length - 1;
  let startTurn = last;
  let accum = turnTokens(last);
  for (let t = last - 1; t >= 0; t--) {
    const cost = turnTokens(t);
    if (accum + cost > opts.seedTokens) break;
    accum += cost;
    startTurn = t;
  }

  const startIdx = boundaries[startTurn];
  const newId = randomUUID();
  const newHeader: PiHeader = {
    type: "session",
    version: typeof header.version === "number" ? header.version : 3,
    id: newId,
    timestamp: new Date().toISOString(),
    cwd: resolve(opts.cwd),
    ...(opts.sourcePath ? { parentSession: opts.sourcePath } : {}),
  };

  // Copy the tail byte-for-byte (tool calls and all), rewriting only the first
  // kept entry's parentId to null so the tail becomes a clean root. Every other
  // entry is emitted from its original raw line, so nothing is re-serialized.
  const lines: string[] = [JSON.stringify(newHeader)];
  for (let i = startIdx; i < entries.length; i++) {
    if (i === startIdx) {
      lines.push(JSON.stringify({ ...entries[i], parentId: null }));
    } else {
      lines.push(entryRaws[i]);
    }
  }
  return { sessionId: newId, lines };
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
 * Seed a fresh persistent pi session from the mind's previous archived transcript.
 * Writes the synthetic session file into `<piSessionsDir>/<name>/` and returns the
 * new session id (the header id continueRecent will adopt), or null if there's
 * nothing to seed. Never throws — any failure returns null so session start is
 * never blocked.
 */
export function seedPiSession(opts: {
  cwd: string;
  piSessionsDir: string;
  name: string;
  seedTokens: number;
}): string | null {
  const { cwd, piSessionsDir, name, seedTokens } = opts;
  // Ephemeral `new-*` sessions are never persisted or archived, so they never
  // seed. The agent caller already gates on this; guard here too so the invariant
  // holds wherever seedPiSession is called.
  if (name.startsWith("new-")) return null;
  if (seedTokens <= 0) return null; // seeding disabled
  // A live session already exists — let continueRecent resume it, don't seed.
  if (hasLivePiSession(piSessionsDir, name)) return null;

  try {
    const archiveDir = findLatestArchivedPiSessionDir(piSessionsDir, name);
    if (!archiveDir) return null;

    // findPiSessionFile picks the latest `.jsonl` in `<base>/<subdir>`; here the
    // subdir is the archived `<name>-<ts>` directory we just located.
    const sourcePath = findPiSessionFile(resolve(piSessionsDir, "archive"), basename(archiveDir));
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
    return seeded.sessionId;
  } catch (err) {
    log("mind", `session "${name}": seeding failed, starting fresh:`, err);
    return null;
  }
}
