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
 * (nulled, to detach the tail from the dropped history).
 *
 * Nothing here throws: any failure returns null so session start is never blocked.
 */

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { findClaudeSessionFile } from "./context-breakdown.js";
import { log } from "./logger.js";
import { parseArchiveTimestamp } from "./seed-note.js";

/** Default seed budget (estimated tokens) when config omits continuity.seedTokens. */
export const DEFAULT_SEED_TOKENS = 30000;

// Archived pointers are named `<name>-<timestamp>.json`, where the timestamp is
// `new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16)` → `YYYY-MM-DDTHH-MM`
// (see archiveSessions in the daemon's sleep-manager). Matching the strict shape
// after the `<name>-` prefix disambiguates `main-...` from a `main-thread-...`.
const ARCHIVE_SUFFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2})\.json$/;

type JsonlLine = Record<string, unknown> & {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  message?: { role?: string; content?: unknown };
};

/** A resolved archive pointer: the previous session id and when it was archived. */
export type ArchivedSession = { sessionId: string; archivedAt: number | null };

/**
 * Newest archived session pointer for `<name>` under `<sessionsDir>/archive/`,
 * or null if there's no matching pointer (or it can't be read). `archivedAt` is
 * the archive timestamp in epoch millis (null if unparseable).
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

  const prefix = `${name}-`;
  let bestTs = "";
  let bestFile: string | null = null;
  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    const match = file.slice(prefix.length).match(ARCHIVE_SUFFIX);
    if (!match) continue;
    // Timestamps are zero-padded ISO, so lexicographic comparison is chronological.
    if (match[1] > bestTs) {
      bestTs = match[1];
      bestFile = file;
    }
  }
  if (!bestFile) return null;

  try {
    const data = JSON.parse(readFileSync(resolve(archiveDir, bestFile), "utf-8"));
    if (typeof data.sessionId !== "string") return null;
    return { sessionId: data.sessionId, archivedAt: parseArchiveTimestamp(bestTs) };
  } catch {
    return null;
  }
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

/** Estimate tokens for a raw JSONL line as its JSON text length / 4. */
function estimateTokens(raw: string): number {
  return raw.length / 4;
}

export type SeededTranscript = { sessionId: string; lines: string[] };

/**
 * Build the seeded transcript from an old transcript's raw jsonl text: take as
 * many whole trailing turns as fit in `seedTokens` (always at least the final
 * turn), rewrite the session id on every line, and null the first chain event's
 * parentUuid. Returns null if there's nothing seedable (empty, no genuine turn,
 * or a corrupt line — in which case the caller starts clean).
 */
export function buildSeededTranscript(jsonl: string, seedTokens: number): SeededTranscript | null {
  const rawLines = jsonl.split("\n").filter((l) => l.trim().length > 0);
  if (rawLines.length === 0) return null;

  const parsed: JsonlLine[] = [];
  const raws: string[] = [];
  for (const raw of rawLines) {
    try {
      parsed.push(JSON.parse(raw));
    } catch {
      // A corrupt line means we can't faithfully reconstruct the chain — start
      // clean rather than seed a broken transcript.
      return null;
    }
    raws.push(raw);
  }

  const boundaries: number[] = [];
  for (let i = 0; i < parsed.length; i++) {
    if (isTurnBoundary(parsed[i])) boundaries.push(i);
  }
  if (boundaries.length === 0) return null;

  // Turn t spans lines [boundaries[t], boundaries[t+1]); the last turn runs to EOF.
  const turnTokens = (t: number): number => {
    const start = boundaries[t];
    const end = t + 1 < boundaries.length ? boundaries[t + 1] : parsed.length;
    let sum = 0;
    for (let i = start; i < end; i++) sum += estimateTokens(raws[i]);
    return sum;
  };

  // Walk backward from the final turn, adding earlier whole turns while they fit.
  // The final turn is always included even if it alone exceeds the budget.
  const last = boundaries.length - 1;
  let startTurn = last;
  let accum = turnTokens(last);
  for (let t = last - 1; t >= 0; t--) {
    const cost = turnTokens(t);
    if (accum + cost > seedTokens) break;
    accum += cost;
    startTurn = t;
  }

  const startLine = boundaries[startTurn];
  const newId = randomUUID();
  const lines: string[] = [];
  let firstChainSeen = false;
  for (let i = startLine; i < parsed.length; i++) {
    const obj = parsed[i];
    if ("sessionId" in obj) obj.sessionId = newId;
    if (!firstChainSeen && isChainEvent(obj)) {
      obj.parentUuid = null;
      firstChainSeen = true;
    }
    lines.push(JSON.stringify(obj));
  }
  return { sessionId: newId, lines };
}

/** Result of a successful seed: the new session id and when the source was archived. */
export type SeedOutcome = { sessionId: string; archivedAt: number | null };

/**
 * Seed a fresh persistent session from the mind's previous archived transcript.
 * Writes the synthetic transcript next to the source file (same project dir) and
 * returns the new SDK session id plus the archived-at time (for the gap note), or
 * null if there's nothing to seed. Never throws — any failure returns null so
 * session start is never blocked.
 */
export function seedSession(opts: {
  cwd: string;
  sessionsDir: string;
  name: string;
  seedTokens: number;
}): SeedOutcome | null {
  const { cwd, sessionsDir, name, seedTokens } = opts;
  // Ephemeral `new-*` sessions are never persisted or archived, so they never
  // seed. The agent caller already gates on this; guard here too so the invariant
  // holds wherever seedSession is called.
  if (name.startsWith("new-")) return null;
  if (seedTokens <= 0) return null; // seeding disabled

  try {
    const archived = findLatestArchivedSession(sessionsDir, name);
    if (!archived) return null;

    const sourcePath = findClaudeSessionFile(cwd, archived.sessionId);
    if (!sourcePath) return null; // transcript didn't survive archival — start clean

    const seeded = buildSeededTranscript(readFileSync(sourcePath, "utf-8"), seedTokens);
    if (!seeded) return null;

    const destPath = resolve(dirname(sourcePath), `${seeded.sessionId}.jsonl`);
    writeFileSync(destPath, `${seeded.lines.join("\n")}\n`);
    log(
      "mind",
      `session "${name}": seeded ${seeded.lines.length} line(s) from ${archived.sessionId} → ${seeded.sessionId}`,
    );
    return { sessionId: seeded.sessionId, archivedAt: archived.archivedAt };
  } catch (err) {
    log("mind", `session "${name}": seeding failed, starting fresh:`, err);
    return null;
  }
}
