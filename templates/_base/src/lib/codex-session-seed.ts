/**
 * Codex session seeding.
 *
 * When a codex mind starts a fresh *persistent* session (no saved thread id —
 * e.g. after a sleep archived the pointer), we seed the new thread by copying
 * the tail of the previous session's Codex rollout into a new synthetic rollout
 * file. The Codex SDK (`codex exec resume <threadId>`) then finds and resumes it
 * natively, so the mind experiences the conversation continuing rather than
 * waking into an empty context.
 *
 * The rollout is reconstructed selectively, not verbatim:
 *   - The `session_meta` header is copied with a fresh thread id (`session_id`
 *     and `id`) and an updated timestamp; `parent_thread_id` is dropped.
 *   - Body `response_item` lines of type `message` and COMPLETE
 *     `custom_tool_call`/`custom_tool_call_output` pairs are kept verbatim.
 *   - `reasoning` items are dropped: their `encrypted_content` is opaque and
 *     provider-bound, the likeliest thing to poison a resume.
 *   - `event_msg` (telemetry), `turn_context`, and `world_state` are dropped;
 *     they carry no conversation content and `turn_context`'s recorded model
 *     would otherwise trigger a spurious model-mismatch warning on resume.
 *
 * Verified against @openai/codex-sdk 0.144.x: `resumeThread` shells out to
 * `codex exec resume <threadId>`, which locates the rollout by scanning
 * CODEX_HOME/sessions for a filename containing the thread id, then reconstructs
 * the conversation from the `response_item` lines. A synthetic rollout with the
 * dropped line types above (and a tail starting at a user message) loads and
 * resumes cleanly.
 *
 * Nothing here throws: any failure returns null so session start is never blocked.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { findCodexSessionFile } from "./context-breakdown.js";
import { log } from "./logger.js";
import { parseArchiveTimestamp } from "./seed-note.js";

/** Default seed budget (estimated tokens) when config omits continuity.seedTokens. */
export const DEFAULT_SEED_TOKENS = 30000;

// Archived pointers are named `<name>-<timestamp>.json`, where the timestamp is
// `new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16)` → `YYYY-MM-DDTHH-MM`
// (see archiveSessions in the daemon's sleep-manager). Matching the strict shape
// after the `<name>-` prefix disambiguates `main-...` from a `main-thread-...`.
const ARCHIVE_SUFFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2})\.json$/;

type RolloutLine = Record<string, unknown> & {
  type?: string;
  timestamp?: string;
  payload?: Record<string, unknown> & {
    type?: string;
    role?: string;
    call_id?: string;
  };
};

/** A resolved archive pointer: the previous thread id and when it was archived. */
export type ArchivedThread = { threadId: string; archivedAt: number | null };

/**
 * Newest archived codex thread for `<name>` under `<sessionsDir>/archive/`, or
 * null if there's no matching pointer (or it can't be read). Codex pointer files
 * hold `{ threadId }` (see the codex template's session-store). `archivedAt` is
 * the archive timestamp in epoch millis (null if unparseable).
 */
export function findLatestArchivedThread(sessionsDir: string, name: string): ArchivedThread | null {
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
    if (typeof data.threadId !== "string") return null;
    return { threadId: data.threadId, archivedAt: parseArchiveTimestamp(bestTs) };
  } catch {
    return null;
  }
}

/** Estimate tokens for a raw JSONL line as its JSON text length / 4. */
function estimateTokens(raw: string): number {
  return raw.length / 4;
}

/** A turn starts at a user `message` response_item (the incoming prompt). */
function isTurnBoundary(o: RolloutLine): boolean {
  return o.payload?.type === "message" && o.payload?.role === "user";
}

/** Response-item payload types that carry conversation content we keep. */
function isKeptBody(o: RolloutLine): boolean {
  if (o.type !== "response_item") return false;
  const pt = o.payload?.type;
  return pt === "message" || pt === "custom_tool_call" || pt === "custom_tool_call_output";
}

/**
 * Generate a UUIDv7 thread id, matching the shape Codex uses (`019f…`): a 48-bit
 * millisecond timestamp prefix plus randomness. The value only needs to be a
 * valid, unique id embedded in the rollout filename and `session_meta`.
 */
export function generateThreadId(now: Date = new Date()): string {
  const bytes = new Uint8Array(16);
  const ms = BigInt(now.getTime());
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number((ms >> BigInt(40 - i * 8)) & 0xffn);
  }
  const rand = randomBytes(10);
  for (let i = 0; i < 10; i++) bytes[6 + i] = rand[i];
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type SeededRollout = { threadId: string; lines: string[] };

/**
 * Build the seeded rollout from a previous rollout's raw jsonl text: rewrite the
 * `session_meta` header to `threadId` with an updated timestamp, then take as
 * many whole trailing turns as fit in `seedTokens` (always at least the final
 * turn), keeping message and complete tool-call pairs. Returns null if there's
 * nothing seedable (empty, no session_meta, no genuine turn, or a corrupt line).
 */
export function buildSeededRollout(
  jsonl: string,
  threadId: string,
  seedTokens: number,
  now: Date = new Date(),
): SeededRollout | null {
  const rawLines = jsonl.split("\n").filter((l) => l.trim().length > 0);
  if (rawLines.length === 0) return null;

  let meta: RolloutLine;
  try {
    meta = JSON.parse(rawLines[0]);
  } catch {
    return null;
  }
  if (meta.type !== "session_meta" || typeof meta.payload !== "object" || meta.payload === null) {
    return null;
  }

  // Rewrite the header: fresh thread id and timestamp, detached from its parent.
  const iso = now.toISOString();
  const mp = meta.payload;
  mp.session_id = threadId;
  mp.id = threadId;
  delete mp.parent_thread_id;
  mp.timestamp = iso;
  meta.timestamp = iso;

  // Parse and filter the body down to the response_items we keep.
  const kept: { obj: RolloutLine; raw: string }[] = [];
  for (let i = 1; i < rawLines.length; i++) {
    let obj: RolloutLine;
    try {
      obj = JSON.parse(rawLines[i]);
    } catch {
      // A corrupt line means we can't faithfully reconstruct — start clean.
      return null;
    }
    if (isKeptBody(obj)) kept.push({ obj, raw: rawLines[i] });
  }
  if (kept.length === 0) return null;

  const boundaries: number[] = [];
  for (let i = 0; i < kept.length; i++) {
    if (isTurnBoundary(kept[i].obj)) boundaries.push(i);
  }
  if (boundaries.length === 0) return null;

  // Turn t spans kept[boundaries[t], boundaries[t+1]); the last turn runs to end.
  const turnTokens = (t: number): number => {
    const start = boundaries[t];
    const end = t + 1 < boundaries.length ? boundaries[t + 1] : kept.length;
    let sum = 0;
    for (let i = start; i < end; i++) sum += estimateTokens(kept[i].raw);
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

  let tail = kept.slice(boundaries[startTurn]);

  // Keep only tool calls/outputs whose call_id has BOTH a call and an output in
  // the tail — never an orphaned call (e.g. a truncated final turn) or output.
  const callIds = new Set<string>();
  const outputIds = new Set<string>();
  for (const { obj } of tail) {
    const p = obj.payload;
    if (typeof p?.call_id !== "string") continue;
    if (p.type === "custom_tool_call") callIds.add(p.call_id);
    else if (p.type === "custom_tool_call_output") outputIds.add(p.call_id);
  }
  tail = tail.filter(({ obj }) => {
    const p = obj.payload;
    if (p?.type === "custom_tool_call" || p?.type === "custom_tool_call_output") {
      return typeof p.call_id === "string" && callIds.has(p.call_id) && outputIds.has(p.call_id);
    }
    return true;
  });
  if (tail.length === 0) return null;

  const lines = [JSON.stringify(meta), ...tail.map((t) => JSON.stringify(t.obj))];
  return { threadId, lines };
}

/** Two-digit zero-padded string for date/time components. */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Result of a successful codex seed: the new thread id and when the source was archived. */
export type SeededThreadOutcome = { threadId: string; archivedAt: number | null };

/**
 * Seed a fresh persistent codex session from the mind's previous archived
 * rollout. Writes the synthetic rollout under `.mind/codex/sessions/YYYY/MM/DD/`
 * (matching the real Codex layout) and returns the new thread id plus the
 * archived-at time (for the gap note), or null if there's nothing to seed. Never
 * throws — any failure returns null so session start is never blocked.
 */
export function seedCodexSession(opts: {
  mindDir: string;
  name: string;
  seedTokens: number;
  now?: Date;
}): SeededThreadOutcome | null {
  const { mindDir, name, seedTokens } = opts;
  const now = opts.now ?? new Date();
  // Ephemeral `new-*` sessions are never persisted or archived, so they never
  // seed. The agent caller already gates on this; guard here too.
  if (name.startsWith("new-")) return null;
  if (seedTokens <= 0) return null; // seeding disabled

  try {
    const sessionsDir = resolve(mindDir, ".mind", "codex-sessions");
    const archived = findLatestArchivedThread(sessionsDir, name);
    if (!archived) return null;
    const oldThreadId = archived.threadId;

    const sourcePath = findCodexSessionFile(oldThreadId, mindDir);
    if (!sourcePath) return null; // rollout didn't survive archival — start clean

    const threadId = generateThreadId(now);
    const seeded = buildSeededRollout(readFileSync(sourcePath, "utf-8"), threadId, seedTokens, now);
    if (!seeded) return null;

    // Write the seed into the SAME sessions root the source rollout was found in,
    // so it lands wherever Codex will look on resume. That root is CODEX_HOME/sessions
    // (`.mind/codex/sessions` when CODEX_HOME is set for the mind) or ~/.codex/sessions
    // otherwise — findCodexSessionFile already resolved whichever holds the old rollout.
    // sourcePath is `<sessionsRoot>/YYYY/MM/DD/rollout-*.jsonl`; climb three levels.
    const sessionsRoot = resolve(dirname(sourcePath), "..", "..", "..");

    // Rollout files live under a local-time YYYY/MM/DD tree, with a local-time
    // filename timestamp — mirroring how Codex itself names them.
    const y = String(now.getFullYear());
    const mo = pad2(now.getMonth() + 1);
    const d = pad2(now.getDate());
    const fnTs = `${y}-${mo}-${d}T${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}`;
    const destDir = resolve(sessionsRoot, y, mo, d);
    mkdirSync(destDir, { recursive: true });
    const destPath = resolve(destDir, `rollout-${fnTs}-${threadId}.jsonl`);
    writeFileSync(destPath, `${seeded.lines.join("\n")}\n`);
    log(
      "mind",
      `session "${name}": seeded ${seeded.lines.length} line(s) from ${oldThreadId} → ${threadId}`,
    );
    return { threadId, archivedAt: archived.archivedAt };
  } catch (err) {
    log("mind", `session "${name}": codex seeding failed, starting fresh:`, err);
    return null;
  }
}
