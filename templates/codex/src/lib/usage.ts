/**
 * Usage normalization for Codex's `turn.completed` event.
 *
 * Two things make codex's numbers incomparable with the other templates until they pass
 * through here, both verified against real rollout JSONL (`.mind/codex/sessions/`):
 *
 * 1. **The counter is session-cumulative, not per-turn.** `turn.completed.usage` carries
 *    codex's `total_token_usage`, which accumulates across every model request in the
 *    thread. On a session with several turns the values climb monotonically (observed:
 *    538002 → 584162 → 630756 → 677701 → 724993 across five consecutive turns), so
 *    summing the raw events over-counts by roughly the square of the turn count. That is
 *    what put one local codex mind at 101.9M input tokens over 165 turns. We keep the last
 *    cumulative snapshot per session and emit the field-wise difference.
 *
 * 2. **`input_tokens` includes the cached portion.** codex-rs computes
 *    `non_cached_input() = input_tokens - cached_input_tokens`, so `cached_input_tokens`
 *    is a *subset* of `input_tokens` — the opposite of the Anthropic/pi convention, where
 *    cache reads sit beside the input count. We subtract it so all four fields are priced
 *    at their own rate.
 *
 * `cache_write_input_tokens` is deliberately *not* subtracted: codex-rs leaves it inside
 * the non-cached input because OpenAI bills cache writes at the ordinary input rate (the
 * catalog prices `cacheWrite` at 0 for OpenAI models). It is reported alongside for
 * visibility; subtracting it would undercount the bill.
 */

/** Codex's `Usage` shape. Fields are optional here because older SDKs omit some. */
export type CodexUsage = {
  input_tokens?: number;
  inputTokens?: number;
  cached_input_tokens?: number;
  cachedInputTokens?: number;
  cache_write_input_tokens?: number;
  cacheWriteInputTokens?: number;
  output_tokens?: number;
  outputTokens?: number;
};

/** A cumulative snapshot, in the normalized field names. */
export type UsageSnapshot = {
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
};

export const ZERO_USAGE: UsageSnapshot = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 };

/** Read a raw codex usage object into a cumulative snapshot (still cache-inclusive input). */
export function readUsage(usage: CodexUsage): UsageSnapshot {
  return {
    input: usage.input_tokens ?? usage.inputTokens ?? 0,
    cacheRead: usage.cached_input_tokens ?? usage.cachedInputTokens ?? 0,
    cacheCreation: usage.cache_write_input_tokens ?? usage.cacheWriteInputTokens ?? 0,
    output: usage.output_tokens ?? usage.outputTokens ?? 0,
  };
}

export type UsageDelta = {
  /** The turn's usage, ready to emit. */
  payload: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  /** The new cumulative snapshot to carry into the next turn. */
  next: UsageSnapshot;
};

/**
 * The usage attributable to this turn, given the previous cumulative snapshot.
 *
 * Returns `null` when nothing moved — codex re-reports an unchanged total when a turn
 * made no model request, and an all-zero usage row is noise in the history.
 *
 * If any field went *backwards* the thread was replaced underneath us, so the current values
 * are themselves the delta.
 *
 * A zero baseline is correct across a mind-server restart, which is worth pinning because it
 * isn't obvious: `resumeThread` replays the prior conversation into a *new* rollout but does
 * not replay the token counter. Verified on a live codex mind — a resumed rollout opens with
 * `response_item`s four days older than the session, and its first `total_token_usage` is one
 * request's worth (36,957) rather than the thread's prior cumulative. Upstream agrees: codex
 * skips restored-usage replay for `exec` resumes, the mode this SDK drives
 * (openai/codex#35621). Were a future codex version to replay it, the symptom would be one
 * outsized usage row immediately after each restart.
 */
export function usageDelta(prev: UsageSnapshot, usage: CodexUsage): UsageDelta | null {
  const next = readUsage(usage);
  // A genuine counter reset always takes `input` down: it is the field that grows on every
  // model request and starts from nothing on a fresh thread. Deliberately *not* "any field
  // went backwards" — that would let a one-token wobble in a minor field zero the baseline
  // for all four and bill a single turn for the entire thread, which is the failure this
  // module exists to prevent. A scan of 42 real rollouts found zero decreases in any field,
  // so both the reset and the wobble are rare; only their blast radii differ.
  const base = next.input < prev.input ? ZERO_USAGE : prev;

  // Clamped per field, so a field that moves backwards on its own contributes zero rather
  // than a negative that would silently discount the turn.
  const input = Math.max(0, next.input - base.input);
  const cacheRead = Math.max(0, next.cacheRead - base.cacheRead);
  const cacheCreation = Math.max(0, next.cacheCreation - base.cacheCreation);
  const output = Math.max(0, next.output - base.output);
  if (input === 0 && cacheRead === 0 && cacheCreation === 0 && output === 0) return null;

  return {
    payload: {
      // Cached reads are a subset of codex's input count — take them out so each is
      // priced at its own rate.
      input_tokens: Math.max(0, input - cacheRead),
      output_tokens: output,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreation,
    },
    next,
  };
}
