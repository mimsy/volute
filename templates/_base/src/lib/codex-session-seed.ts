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
 *     and `id`) and an updated timestamp; `parent_thread_id` and `base_instructions`
 *     are dropped (see emitRollout).
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
 * A final turn too large for the budget on its own keeps its opening prompt, marked
 * as trimmed, and its latest whole steps (the planner is shared with the claude
 * seeder — see planTail in session-seed.ts).
 *
 * When the caller passes a recollection source, the mind's recall entries go ahead
 * of the tail as `message` pairs: a user `[recall: …]` line, then the memory as the
 * mind's own assistant text — the claude seeder's shape. codex 0.156.1 replays every
 * `response_item` message whose role isn't `system` into the resumed history
 * (codex-rs core/src/session/rollout_reconstruction.rs → context_manager/history.rs
 * `is_api_message`).
 *
 * Nothing here throws: any failure returns null so session start is never blocked.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { findCodexSessionFile } from "./context-breakdown.js";
import { log } from "./logger.js";
import { parseArchiveTimestamp } from "./seed-note.js";
import {
  archivePointerTimestamp,
  hasRecollect,
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
  TAIL_ONLY_SEED_TOKENS,
  type TailPlan,
  TRIMMED_TURN_MARKER,
  type WithRecollection,
} from "./session-seed.js";

/**
 * Default seed budget when config omits continuity.seedTokens: the codex template
 * doesn't fetch recollection at its seams yet, so the tail carries continuity alone.
 */
export const DEFAULT_SEED_TOKENS = TAIL_ONLY_SEED_TOKENS;

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
    content?: unknown;
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

function codexTextTokens(s: string): number {
  return s.length / OPENAI_CHARS_PER_TOKEN;
}

/** Content items (message content, tool output): text, or a flat cost per image. */
function contentItemsTokens(content: unknown): number {
  if (typeof content === "string") return codexTextTokens(content);
  if (!Array.isArray(content))
    return content == null ? 0 : codexTextTokens(JSON.stringify(content));
  let sum = 0;
  for (const item of content as (Record<string, unknown> | null)[]) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "input_image") sum += IMAGE_TOKENS;
    else if (typeof item.text === "string") sum += codexTextTokens(item.text);
    else sum += codexTextTokens(JSON.stringify(item));
  }
  return sum;
}

/** Estimated model tokens a kept response_item puts back in context. */
export function estimateRolloutItemTokens(o: RolloutLine): number {
  const p = o.payload;
  switch (p?.type) {
    case "message":
      return contentItemsTokens(p.content);
    case "custom_tool_call":
      return codexTextTokens(String(p.name ?? "") + String(p.input ?? ""));
    case "custom_tool_call_output":
      return contentItemsTokens(p.output);
    default:
      return 0;
  }
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

/** The session_meta header plus the response_items we keep (messages + tool pairs). */
type ParsedRollout = { meta: RolloutLine; kept: RolloutLine[] };

/** The first text of a message payload, if any. */
function firstText(o: RolloutLine): string | undefined {
  const content = o.payload?.content;
  const first = Array.isArray(content) ? (content[0] as { text?: unknown } | undefined) : undefined;
  return typeof first?.text === "string" ? first.text : undefined;
}

const isMessage = (o: RolloutLine, role: string) =>
  o.payload?.type === "message" && o.payload?.role === role;

// A recall heading on the message's first line, or on its second after a preamble line —
// matched on the heading, not the preamble's wording, which may change between releases.
const RECALL_HEADING = /^(?:[^\n]*\n)?\[recall: /;

/**
 * Drop the recall pairs an earlier seam wrote — each seam asks the daemon afresh. A
 * seed writes them first, straight after session_meta, and codex appends after them,
 * so they are exactly the leading run of user messages carrying a `[recall: …]`
 * heading, each with the assistant message that follows it. Recognised by content
 * because a codex message has nowhere else to carry a mark: unknown fields may not
 * survive codex's own reader, and a made-up item `id` could be sent to the API.
 */
function dropEarlierRecall(kept: RolloutLine[]): RolloutLine[] {
  let i = 0;
  while (i < kept.length && isMessage(kept[i], "user")) {
    if (!RECALL_HEADING.test(firstText(kept[i]) ?? "")) break;
    i += i + 1 < kept.length && isMessage(kept[i + 1], "assistant") ? 2 : 1;
  }
  return kept.slice(i);
}

/**
 * Parse a rollout into its session_meta header and the kept body lines (earlier
 * recall dropped). A corrupt body line aborts (returns null — a broken line means we
 * can't faithfully reconstruct). Returns null if the first line isn't session_meta.
 */
function parseRollout(jsonl: string): ParsedRollout | null {
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

  const kept: RolloutLine[] = [];
  for (let i = 1; i < rawLines.length; i++) {
    let obj: RolloutLine;
    try {
      obj = JSON.parse(rawLines[i]);
    } catch {
      return null;
    }
    if (isKeptBody(obj)) kept.push(obj);
  }
  return { meta, kept: dropEarlierRecall(kept) };
}

function hasTrimMarker(o: RolloutLine): boolean {
  const content = o.payload?.content;
  if (!Array.isArray(content)) return false;
  return (content.at(-1) as { text?: unknown } | undefined)?.text === TRIMMED_TURN_MARKER;
}

/** Output items: an assistant message or a tool call. */
const isModelSide = (o: RolloutLine) =>
  isMessage(o, "assistant") || o.payload?.type === "custom_tool_call";

/**
 * Map kept items onto the shared planner's lines. A step starts at an output item that
 * doesn't follow another one: the calls a response issues are recorded together, ahead
 * of their outputs, so a cut never lands between them (and a cut that would orphan an
 * output is refused by the planner either way). Rollouts carry no parent chain.
 */
function toSeedLines(kept: RolloutLine[]): SeedLine[] {
  return kept.map((o, i) => {
    const p = o.payload;
    const callId = typeof p?.call_id === "string" ? p.call_id : undefined;
    return {
      tokens: estimateRolloutItemTokens(o),
      boundary: isTurnBoundary(o),
      stepStart: isModelSide(o) && (i === 0 || !isModelSide(kept[i - 1])),
      uses: p?.type === "custom_tool_call" && callId ? [callId] : [],
      results: p?.type === "custom_tool_call_output" && callId ? [callId] : [],
      marked: hasTrimMarker(o),
    };
  });
}

/** Append the trim marker to a prompt message's content, once. */
function markTrimmed(o: RolloutLine): RolloutLine {
  if (hasTrimMarker(o)) return o;
  const content = Array.isArray(o.payload?.content) ? o.payload.content : [];
  return {
    ...o,
    payload: {
      ...o.payload,
      content: [...content, { type: "input_text", text: TRIMMED_TURN_MARKER }],
    },
  };
}

/** Recall entries as `message` pairs: the `[recall: …]` line, then the memory as the mind's own words. */
function renderCodexRecall(recall: RecallEntry[], timeZone: string | undefined): RolloutLine[] {
  return recall.flatMap((entry, k) => {
    const timestamp = recallTimestamp(entry);
    const heading = recallHeading(entry, timeZone);
    return [
      {
        timestamp,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: k === 0 ? `${RECALL_PREAMBLE}\n${heading}` : heading },
          ],
        },
      },
      {
        timestamp,
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: entry.content }],
        },
      },
    ];
  });
}

export type SeededRollout = { threadId: string; lines: string[]; recallEntries: number };

type PlannedRollout = ParsedRollout & { plan: TailPlan; tailStartedAt?: string };

/** Parse and plan the tail. Null if there's nothing seedable. */
function planRolloutSeed(jsonl: string, seedTokens: number): PlannedRollout | null {
  const p = parseRollout(jsonl);
  if (!p) return null;
  const plan = planTail(
    toSeedLines(p.kept),
    seedTokens,
    TRIMMED_TURN_MARKER.length / OPENAI_CHARS_PER_TOKEN,
  );
  if (!plan) return null;
  const first = plan.keep.map((i) => p.kept[i]).find((o) => typeof o.timestamp === "string");
  return { ...p, plan, tailStartedAt: first?.timestamp };
}

/**
 * Emit the seeded rollout: rewrite the header to `threadId`/`now`, then any recall
 * pairs, then the planned tail (a trimmed turn's prompt carrying the marker), dropping
 * any tool call/output whose partner isn't in the tail. Returns null if the tail ends
 * up empty.
 *
 * The header drops `base_instructions`: copied along, it carried the soul the chain
 * *started* with into every later seed. codex 0.156.1 takes `model_instructions_file`
 * (which the codex template always passes, freshly written) over a resumed rollout's
 * `base_instructions` (codex-rs core/src/session/mod.rs, "Resolve base instructions"),
 * so the stale copy never reached the model — but it was a false record, and would
 * have become the prompt had that precedence ever changed.
 */
function emitRollout(
  planned: PlannedRollout,
  threadId: string,
  now: Date,
  recall: RecallEntry[] = [],
  timeZone?: string,
): SeededRollout | null {
  const { meta, kept, plan } = planned;
  const iso = now.toISOString();
  const mp = meta.payload as Record<string, unknown>;
  mp.session_id = threadId;
  mp.id = threadId;
  delete mp.parent_thread_id;
  delete mp.base_instructions;
  mp.timestamp = iso;
  meta.timestamp = iso;

  let tail = plan.keep.map((i) => (plan.trimmedAt?.prompt === i ? markTrimmed(kept[i]) : kept[i]));

  // Keep only tool calls/outputs whose call_id has BOTH a call and an output in
  // the tail — never an orphaned call (e.g. a truncated final turn) or output.
  const callIds = new Set<string>();
  const outputIds = new Set<string>();
  for (const obj of tail) {
    const p = obj.payload;
    if (typeof p?.call_id !== "string") continue;
    if (p.type === "custom_tool_call") callIds.add(p.call_id);
    else if (p.type === "custom_tool_call_output") outputIds.add(p.call_id);
  }
  tail = tail.filter((obj) => {
    const p = obj.payload;
    if (p?.type === "custom_tool_call" || p?.type === "custom_tool_call_output") {
      return typeof p.call_id === "string" && callIds.has(p.call_id) && outputIds.has(p.call_id);
    }
    return true;
  });
  if (tail.length === 0) return null;

  const lines = [meta, ...renderCodexRecall(recall, timeZone), ...tail].map((o) =>
    JSON.stringify(o),
  );
  return { threadId, lines, recallEntries: recall.length };
}

/**
 * Build the seeded rollout from a previous rollout's raw jsonl text: rewrite the
 * `session_meta` header to `threadId` with an updated timestamp, then any recall
 * pairs, then as many whole trailing turns as fit in `seedTokens` (trimming the final
 * turn when it alone is over budget — see planTail), keeping message and complete
 * tool-call pairs. Returns null if there's nothing seedable (empty, no session_meta,
 * no genuine turn, or a corrupt line).
 */
export function buildSeededRollout(
  jsonl: string,
  threadId: string,
  seedTokens: number,
  now: Date = new Date(),
  recall: RecallEntry[] = [],
  timeZone?: string,
): SeededRollout | null {
  const planned = planRolloutSeed(jsonl, seedTokens);
  return planned ? emitRollout(planned, threadId, now, recall, timeZone) : null;
}

/**
 * Plan and emit a seed, fetching recollection first (see planWithRecollection — the
 * budget and fail-soft rules are claude's).
 */
async function composeRolloutSeed(
  jsonl: string,
  threadId: string,
  now: Date,
  opts: RecollectionOptions & SeedBudget & { name: string; before: Date },
): Promise<SeededRollout | null> {
  const composed = await planWithRecollection((budget) => planRolloutSeed(jsonl, budget), opts);
  if (!composed) return null;
  return emitRollout(composed.planned, threadId, now, composed.recall, opts.timeZone);
}

/** Two-digit zero-padded string for date/time components. */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Result of a successful codex seed: the new thread id, when the source was archived,
 * and how many recall entries went ahead of the tail.
 */
export type SeededThreadOutcome = {
  threadId: string;
  archivedAt: number | null;
  recallEntries: number;
};

/**
 * `sessionsRoot` is where codex will look for the seed on resume — CODEX_HOME/sessions for
 * the auth mode the mind will resume under. Omitted, the seed goes beside its source.
 */
type SeedCodexOptions = {
  mindDir: string;
  name: string;
  seedTokens: number;
  now?: Date;
  sessionsRoot?: string;
};

/** Where a seed comes from: the rollout of the newest archived thread for `name`. */
function findCodexSeedSource(opts: {
  mindDir: string;
  name: string;
  seedTokens?: number;
}): { oldThreadId: string; sourcePath: string; archivedAt: number | null } | null {
  const { mindDir, name, seedTokens } = opts;
  // Ephemeral `new-*` sessions are never persisted or archived, so they never
  // seed. The agent caller already gates on this; guard here too.
  if (name.startsWith("new-")) return null;
  if (seedTokens !== undefined && seedTokens <= 0) return null; // seeding disabled
  const sessionsDir = resolve(mindDir, ".mind", "codex-sessions");
  const archived = findLatestArchivedThread(sessionsDir, name);
  if (!archived) return null;
  const sourcePath = findCodexSessionFile(archived.threadId, mindDir);
  if (!sourcePath) return null; // rollout didn't survive archival — start clean
  return { oldThreadId: archived.threadId, sourcePath, archivedAt: archived.archivedAt };
}

function seededCodex(
  opts: { name: string; sessionsRoot?: string },
  source: { oldThreadId: string; sourcePath: string; archivedAt: number | null },
  seeded: SeededRollout | null,
  now: Date,
): SeededThreadOutcome | null {
  if (!seeded) return null;
  const { name } = opts;
  writeSeededRollout(opts.sessionsRoot ?? sessionsRootOf(source.sourcePath), seeded, now);
  log(
    "mind",
    `session "${name}": seeded ${seeded.lines.length} line(s) (${seeded.recallEntries} recalled) from ${source.oldThreadId} → ${seeded.threadId}`,
  );
  return {
    threadId: seeded.threadId,
    archivedAt: source.archivedAt,
    recallEntries: seeded.recallEntries,
  };
}

/**
 * Seed a fresh persistent codex session from the mind's previous archived
 * rollout. Writes the synthetic rollout under `<sessionsRoot>/YYYY/MM/DD/` (matching
 * the real Codex layout; beside the source rollout when `sessionsRoot` is omitted) and
 * returns the new thread id plus the
 * archived-at time (for the gap note), or null if there's nothing to seed. Never
 * throws — any failure returns null so session start is never blocked.
 *
 * Given a `recollect` source, it is async: the mind's recollection up to the archive
 * time goes ahead of the tail; without one it seeds the tail alone, synchronously.
 */
export function seedCodexSession(
  opts: WithRecollection<SeedCodexOptions>,
): Promise<SeededThreadOutcome | null>;
export function seedCodexSession(opts: SeedCodexOptions): SeededThreadOutcome | null;
export function seedCodexSession(
  opts: SeedCodexOptions | WithRecollection<SeedCodexOptions>,
): SeededThreadOutcome | null | Promise<SeededThreadOutcome | null> {
  const now = opts.now ?? new Date();
  const fail = (err: unknown) => {
    log("mind", `session "${opts.name}": codex seeding failed, starting fresh:`, err);
    return null;
  };
  try {
    const source = findCodexSeedSource(opts);
    if (!source) return hasRecollect(opts) ? Promise.resolve(null) : null;
    const jsonl = readFileSync(source.sourcePath, "utf-8");
    const threadId = generateThreadId(now);
    if (hasRecollect(opts)) {
      return composeRolloutSeed(jsonl, threadId, now, {
        ...opts,
        before: new Date(source.archivedAt ?? now.getTime()),
      })
        .then((seeded) => seededCodex(opts, source, seeded, now))
        .catch(fail);
    }
    return seededCodex(
      opts,
      source,
      buildSeededRollout(jsonl, threadId, opts.seedTokens, now),
      now,
    );
  } catch (err) {
    const result = fail(err);
    return hasRecollect(opts) ? Promise.resolve(result) : result;
  }
}

/**
 * The sessions root a rollout was found in: `<sessionsRoot>/YYYY/MM/DD/rollout-*.jsonl`,
 * so three levels up.
 */
function sessionsRootOf(sourcePath: string): string {
  return resolve(dirname(sourcePath), "..", "..", "..");
}

/**
 * Write a seeded rollout under `sessionsRoot` — the root codex will read on resume
 * (CODEX_HOME/sessions). Rollouts live under a local-time YYYY/MM/DD tree with a
 * local-time filename timestamp, mirroring how Codex itself names them.
 */
function writeSeededRollout(sessionsRoot: string, seeded: SeededRollout, now: Date): void {
  const y = String(now.getFullYear());
  const mo = pad2(now.getMonth() + 1);
  const d = pad2(now.getDate());
  const fnTs = `${y}-${mo}-${d}T${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}`;
  const destDir = resolve(sessionsRoot, y, mo, d);
  mkdirSync(destDir, { recursive: true });
  writeFileSync(
    resolve(destDir, `rollout-${fnTs}-${seeded.threadId}.jsonl`),
    `${seeded.lines.join("\n")}\n`,
  );
}

/**
 * Write an archive pointer for a rotated-out codex thread, matching how sleep archival
 * preserves the live pointer: `<sessionsDir>/archive/<name>-<UTC-ts>.json` holding
 * `{ threadId }` (the codex session-store format). Reuses the shared timestamp format
 * (archivePointerTimestamp) so the byte layout matches sleep-manager's codex branch and
 * findLatestArchivedThread keeps finding it.
 */
export function writeCodexRotationArchivePointer(
  sessionsDir: string,
  name: string,
  threadId: string,
  now: Date = new Date(),
): void {
  const archiveDir = resolve(sessionsDir, "archive");
  mkdirSync(archiveDir, { recursive: true });
  const dest = resolve(archiveDir, `${name}-${archivePointerTimestamp(now)}.json`);
  writeFileSync(dest, JSON.stringify({ threadId }));
}

type RotateCodexOptions = {
  mindDir: string;
  name: string;
  oldThreadId: string;
  seedTokens: number;
  now?: Date;
  /** Where codex will look for the seed on resume; omitted, beside the source. */
  sessionsRoot?: string;
};

/** A rotation with recollection: the new thread id and how many recall entries it carries. */
export type RotatedCodexOutcome = { threadId: string; recallEntries: number };

/** Write the rotated seed and archive the rotated-out thread's pointer. */
function adoptRotatedCodex(
  opts: RotateCodexOptions | WithRecollection<RotateCodexOptions>,
  sourcePath: string,
  seeded: SeededRollout,
  now: Date,
): void {
  const { mindDir, name, oldThreadId } = opts;
  writeSeededRollout(opts.sessionsRoot ?? sessionsRootOf(sourcePath), seeded, now);
  // Ephemeral `new-*` sessions rotate too, but leave no pointer/archive behind.
  if (!name.startsWith("new-")) {
    const sessionsDir = resolve(mindDir, ".mind", "codex-sessions");
    writeCodexRotationArchivePointer(sessionsDir, name, oldThreadId, now);
  }
  log(
    "mind",
    `session "${name}": rotated ${oldThreadId} → ${seeded.threadId} (${seeded.lines.length} lines, ${seeded.recallEntries} recalled)`,
  );
}

/**
 * Rotate a codex session in place at the context limit. Reads the live rollout, builds
 * a seeded budget-based tail (trimming an over-budget final turn), writes it as a new
 * synthetic rollout under `sessionsRoot` (beside the source when omitted), and — for persistent sessions — archives the
 * rotated-out thread pointer so the full transcript stays findable. Returns the new
 * thread id, or null if rotation can't proceed (the caller then leaves the old thread
 * in place). Never throws.
 *
 * Given a `recollect` source, it is async, seeds the mind's recollection ahead of the
 * tail, and resolves to the thread id plus how many recall entries it carries. The caller
 * must hold the session quiet across that await: the live transcript is read before it,
 * so anything appended while recollection loads never reaches the new session (the
 * claude agent drops its query before awaiting, for the same
 * reason).
 */
export function rotateCodexSession(
  opts: WithRecollection<RotateCodexOptions>,
): Promise<RotatedCodexOutcome | null>;
export function rotateCodexSession(opts: RotateCodexOptions): string | null;
export function rotateCodexSession(
  opts: RotateCodexOptions | WithRecollection<RotateCodexOptions>,
): string | null | Promise<RotatedCodexOutcome | null> {
  const now = opts.now ?? new Date();
  const fail = (err: unknown) => {
    log("mind", `session "${opts.name}": rotation failed:`, err);
    return null;
  };
  try {
    const sourcePath = findCodexSessionFile(opts.oldThreadId, opts.mindDir);
    if (!sourcePath) return hasRecollect(opts) ? Promise.resolve(null) : null; // live rollout not found — leave the old thread
    const jsonl = readFileSync(sourcePath, "utf-8");
    const threadId = generateThreadId(now);
    if (hasRecollect(opts)) {
      return composeRolloutSeed(jsonl, threadId, now, { ...opts, before: now })
        .then((seeded) => {
          if (!seeded) return null;
          adoptRotatedCodex(opts, sourcePath, seeded, now);
          return { threadId, recallEntries: seeded.recallEntries };
        })
        .catch(fail);
    }
    const seeded = buildSeededRollout(jsonl, threadId, opts.seedTokens, now);
    if (!seeded) return null;
    adoptRotatedCodex(opts, sourcePath, seeded, now);
    return threadId;
  } catch (err) {
    const result = fail(err);
    return hasRecollect(opts) ? Promise.resolve(result) : result;
  }
}
