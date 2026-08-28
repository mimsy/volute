/**
 * Usage extraction for the Claude Agent SDK's `result` message.
 *
 * The SDK reports cache reads/writes as fields alongside `input_tokens` (they are *not*
 * folded into it), so the shape maps straight onto the daemon's usage event.
 *
 * `result.usage` is the turn's own usage; `result.modelUsage` is the stream's running
 * total. Only the first is safe to forward as-is — see `usageByModel`.
 */

import type { UsageByModel } from "./types.js";

/** The subset of the SDK result message this reads. Loosely typed — fields are optional at runtime. */
export type ResultUsage = {
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<string, ModelUsageEntry | undefined>;
};

/** The cumulative per-model counters a `result` carries, keyed by model id. */
export type ModelUsageMap = ResultUsage["modelUsage"];

type ModelUsageEntry = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
};

export type UsagePayload = {
  input_tokens: number;
  output_tokens: number;
  /** Omitted, not zeroed, when the SDK reports no cache fields at all — see below. */
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  model?: string;
  models?: UsageByModel[];
};

/** Every token a slice accounts for, cache included. */
function totalTokens(slice: UsageByModel): number {
  return (
    slice.input_tokens +
    slice.output_tokens +
    slice.cache_read_input_tokens +
    slice.cache_creation_input_tokens
  );
}

/**
 * The counter this model starts the turn from.
 *
 * Zero when the model is new to the stream, and zero again when its counter went
 * *backwards* — the SDK replaced the accumulator underneath us, so the current values are
 * themselves the turn's usage. Keyed on `outputTokens` alone, like the codex module's
 * equivalent: it is the field that grows on every request a model serves, and testing all
 * four would let a one-token wobble in a minor field rebase the rest, billing a single
 * turn for the whole stream — the exact failure this differencing exists to prevent.
 */
function baselineFor(prev: ModelUsageEntry | undefined, cur: ModelUsageEntry): ModelUsageEntry {
  if (!prev) return {};
  return (cur.outputTokens ?? 0) < (prev.outputTokens ?? 0) ? {} : prev;
}

/**
 * This turn's per-model usage, as slices the daemon can price independently.
 *
 * A turn routinely touches more than one model — a Haiku side-call for a summary, a
 * subagent on another model — and the top-level `usage` covers only the primary one. Rates
 * differ by up to 5x between them, so attributing the whole turn to any single model can
 * be wrong by that much in either direction. Slices priced separately and summed are
 * simply correct.
 *
 * **`modelUsage` is session-cumulative, not per-turn** (verified against live minds, #981):
 * it carries the running total for every model since the stream opened, while
 * `result.usage` carries this turn's delta. Forwarded raw, the daemon bills each turn for
 * the whole stream so far — spend grows as the sum of partial sums, which on bardo billed
 * one $0.36 turn at $4.22 and held a mind that had not reached its cap. So `prev`, the
 * previous result's `modelUsage`, is subtracted field-wise here. The same shape of counter,
 * for the same reason, is differenced in the codex template's `usageDelta`.
 *
 * Models that consumed nothing *this turn* are dropped: they'd contribute a zero and could
 * still fail to resolve, which would take the whole turn unpriced. The drop has to happen
 * after differencing — a model that sat this turn out still has a non-zero cumulative.
 */
export function usageByModel(
  modelUsage: ModelUsageMap,
  prev?: ModelUsageMap,
): UsageByModel[] | undefined {
  if (!modelUsage) return undefined;
  const slices: UsageByModel[] = [];
  for (const [model, mu] of Object.entries(modelUsage)) {
    if (!mu) continue;
    const base = baselineFor(prev?.[model], mu);
    const slice: UsageByModel = {
      model,
      // Clamped per field, so one that moves backwards on its own contributes zero rather
      // than a negative that would silently discount the turn.
      input_tokens: Math.max(0, (mu.inputTokens ?? 0) - (base.inputTokens ?? 0)),
      output_tokens: Math.max(0, (mu.outputTokens ?? 0) - (base.outputTokens ?? 0)),
      cache_read_input_tokens: Math.max(
        0,
        (mu.cacheReadInputTokens ?? 0) - (base.cacheReadInputTokens ?? 0),
      ),
      cache_creation_input_tokens: Math.max(
        0,
        (mu.cacheCreationInputTokens ?? 0) - (base.cacheCreationInputTokens ?? 0),
      ),
    };
    if (totalTokens(slice) === 0) continue;
    slices.push(slice);
  }
  return slices.length > 0 ? slices : undefined;
}

/**
 * The model that did most of *this turn's* work — a display label, not the pricing basis.
 *
 * Ranked on all four token counts, cache included. Ranking on input+output alone would
 * hand the label to a small side-call whenever the main model's context arrives as cache
 * reads, which for a long-running mind is the normal case rather than the exception.
 *
 * Takes the differenced slices, not the raw cumulative: ranked on lifetime totals, a
 * stream dominated by one model would label every side-call-only turn with it forever.
 */
export function dominantModel(slices: UsageByModel[] | undefined): string | undefined {
  let best: string | undefined;
  let bestTokens = -1;
  for (const slice of slices ?? []) {
    const tokens = totalTokens(slice);
    if (tokens > bestTokens) {
      bestTokens = tokens;
      best = slice.model;
    }
  }
  return best;
}

/**
 * Build the usage event payload for a completed turn, or undefined when the result carries
 * no usage at all.
 *
 * The cache fields are passed through rather than defaulted: the SDK's `NonNullableUsage`
 * reports a real `0` for a turn that used no cache, so absence means the SDK itself didn't
 * report them. Manufacturing a zero there would price the turn as if nothing was cached —
 * an undercount by orders of magnitude that nothing downstream could detect. Left absent,
 * the daemon flags the turn `partial` and declines to price it.
 */
export function buildUsagePayload(
  result: ResultUsage,
  prev?: ModelUsageMap,
): UsagePayload | undefined {
  if (!result.usage) return undefined;
  const { cache_read_input_tokens, cache_creation_input_tokens } = result.usage;
  const models = usageByModel(result.modelUsage, prev);
  const payload: UsagePayload = {
    input_tokens: result.usage.input_tokens ?? 0,
    output_tokens: result.usage.output_tokens ?? 0,
    model: dominantModel(models),
    models,
  };
  if (cache_read_input_tokens !== undefined || cache_creation_input_tokens !== undefined) {
    payload.cache_read_input_tokens = cache_read_input_tokens ?? 0;
    payload.cache_creation_input_tokens = cache_creation_input_tokens ?? 0;
  }
  return payload;
}
