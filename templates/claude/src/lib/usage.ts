/**
 * Usage extraction for the Claude Agent SDK's `result` message.
 *
 * The SDK reports cache reads/writes as fields alongside `input_tokens` (they are *not*
 * folded into it), so the shape maps straight onto the daemon's usage event.
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

/** Every token a model consumed on this turn, cache included. */
function totalTokens(mu: ModelUsageEntry | undefined): number {
  return (
    (mu?.inputTokens ?? 0) +
    (mu?.outputTokens ?? 0) +
    (mu?.cacheReadInputTokens ?? 0) +
    (mu?.cacheCreationInputTokens ?? 0)
  );
}

/**
 * The result's per-model usage, as slices the daemon can price independently.
 *
 * A turn routinely touches more than one model — a Haiku side-call for a summary, a
 * subagent on another model — and the top-level `usage` is their sum. Rates differ by up
 * to 5x between them, so attributing the whole turn to any single model can be wrong by
 * that much in either direction. Slices priced separately and summed are simply correct.
 *
 * Models that consumed nothing are dropped; they'd contribute a zero and could still fail
 * to resolve, which would take the whole turn unpriced.
 */
export function usageByModel(modelUsage: ResultUsage["modelUsage"]): UsageByModel[] | undefined {
  if (!modelUsage) return undefined;
  const slices: UsageByModel[] = [];
  for (const [model, mu] of Object.entries(modelUsage)) {
    if (!mu || totalTokens(mu) === 0) continue;
    slices.push({
      model,
      input_tokens: mu.inputTokens ?? 0,
      output_tokens: mu.outputTokens ?? 0,
      cache_read_input_tokens: mu.cacheReadInputTokens ?? 0,
      cache_creation_input_tokens: mu.cacheCreationInputTokens ?? 0,
    });
  }
  return slices.length > 0 ? slices : undefined;
}

/**
 * The model that did most of the turn's work — a display label, not the pricing basis.
 *
 * Ranked on all four token counts, cache included. Ranking on input+output alone would
 * hand the label to a small side-call whenever the main model's context arrives as cache
 * reads, which for a long-running mind is the normal case rather than the exception.
 */
export function dominantModel(modelUsage: ResultUsage["modelUsage"]): string | undefined {
  if (!modelUsage) return undefined;
  let best: string | undefined;
  let bestTokens = -1;
  for (const [id, mu] of Object.entries(modelUsage)) {
    const tokens = totalTokens(mu);
    if (tokens > bestTokens) {
      bestTokens = tokens;
      best = id;
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
export function buildUsagePayload(result: ResultUsage): UsagePayload | undefined {
  if (!result.usage) return undefined;
  const { cache_read_input_tokens, cache_creation_input_tokens } = result.usage;
  const payload: UsagePayload = {
    input_tokens: result.usage.input_tokens ?? 0,
    output_tokens: result.usage.output_tokens ?? 0,
    model: dominantModel(result.modelUsage),
    models: usageByModel(result.modelUsage),
  };
  if (cache_read_input_tokens !== undefined || cache_creation_input_tokens !== undefined) {
    payload.cache_read_input_tokens = cache_read_input_tokens ?? 0;
    payload.cache_creation_input_tokens = cache_creation_input_tokens ?? 0;
  }
  return payload;
}
