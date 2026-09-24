/**
 * Usage extraction for the Claude Agent SDK's `result` message.
 *
 * The SDK reports cache reads/writes as fields alongside `input_tokens` (they are *not*
 * folded into it), so the shape maps straight onto the daemon's usage event.
 *
 * `result.usage` is the turn's own usage, but the **main loop's only** — Task subagents and
 * side-calls are missing from it. `result.modelUsage` counts everything, but as the
 * stream's running total. So the aggregate is forwarded as-is and the breakdown is
 * differenced — see `usageByModel`.
 */

import type { UsageByModel } from "./types.js";

/** The subset of the SDK result message this reads. Loosely typed — fields are optional at runtime. */
export type ResultUsage = {
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
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
  cache_creation_1h_input_tokens?: number;
  main_model?: string;
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

const COUNTERS = [
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
] as const;

/**
 * The counter this model starts the turn from.
 *
 * Zero when the model is new to the stream, and zero again when *any* of its counters went
 * backwards — the SDK replaced the accumulator underneath us (a /clear, a resume), so the
 * current values are themselves the turn's usage. The SDK's counters only ever grow within
 * one accumulator, so a drop in any field is a reset; testing output alone missed a reset
 * whose new output had already passed the old one, and undercounted that turn by the
 * difference. The daemon trusts this differencing outright (#984), so it has to be right.
 */
function baselineFor(prev: ModelUsageEntry | undefined, cur: ModelUsageEntry): ModelUsageEntry {
  if (!prev) return {};
  return COUNTERS.some((k) => (cur[k] ?? 0) < (prev[k] ?? 0)) ? {} : prev;
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
 *
 * `mainModel` is the `system/init` message's model — the key the SDK files the main loop
 * under in `modelUsage`. Sent as `main_model`, it tells the daemon which slice the 1-hour
 * cache writes belong to (the main loop's; subagents write 5-minute entries) and that the
 * breakdown is already this turn's own, so a slice larger than `usage` is a subagent at
 * work rather than a running total (#984). With no breakdown it is also the `model`: the
 * aggregate is the main loop's alone, and without a model the daemon would guess one.
 */
export function buildUsagePayload(
  result: ResultUsage,
  prev?: ModelUsageMap,
  mainModel?: string,
): UsagePayload | undefined {
  if (!result.usage) return undefined;
  const { cache_read_input_tokens, cache_creation_input_tokens, cache_creation } = result.usage;
  const models = usageByModel(result.modelUsage, prev);
  const payload: UsagePayload = {
    input_tokens: result.usage.input_tokens ?? 0,
    output_tokens: result.usage.output_tokens ?? 0,
    model: dominantModel(models) ?? mainModel,
    models,
  };
  if (mainModel) payload.main_model = mainModel;
  if (cache_read_input_tokens !== undefined || cache_creation_input_tokens !== undefined) {
    payload.cache_read_input_tokens = cache_read_input_tokens ?? 0;
    payload.cache_creation_input_tokens = cache_creation_input_tokens ?? 0;
  }
  if (cache_creation?.ephemeral_1h_input_tokens !== undefined) {
    payload.cache_creation_1h_input_tokens = cache_creation.ephemeral_1h_input_tokens;
  }
  return payload;
}

/**
 * The per-model totals a resumed stream's `modelUsage` opens at, read from the session's
 * transcript — the baseline its first turn is differenced against.
 *
 * Since SDK 0.3.277 a resumed session's counters continue from the last valid `cost-state`
 * line its transcript holds for that session id, and **every** model in it is restored,
 * not only the main one: a subagent's model and an ai-title side-call's come back too
 * (#1155, verified live on 0.3.281). The line is written when a stream ends, so it can
 * include calls the previous stream's last `result` never reported; subtracting it —
 * rather than the last `modelUsage` this process saw — is what makes the difference exact.
 *
 * This mirrors the SDK's own reading: a line under another session id is ignored, and so
 * is one that fails the SDK's schema (`modelUsage` a record of entries with all four
 * counters as non-negative numbers) — the SDK skips it and an earlier valid line stands.
 * With no valid line the SDK starts from zero, which the empty map says.
 */
export function restoredTotals(jsonl: string, sessionId: string): NonNullable<ModelUsageMap> {
  let totals: NonNullable<ModelUsageMap> = {};
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"cost-state"')) continue;
    let entry: { type?: unknown; sessionId?: unknown; modelUsage?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "cost-state" || entry.sessionId !== sessionId) continue;
    if (isModelUsageMap(entry.modelUsage)) totals = entry.modelUsage;
  }
  return totals;
}

function isModelUsageMap(value: unknown): value is NonNullable<ModelUsageMap> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(
    (mu) =>
      mu &&
      typeof mu === "object" &&
      COUNTERS.every((k) => {
        const n = (mu as Record<string, unknown>)[k];
        return typeof n === "number" && Number.isFinite(n) && n >= 0;
      }),
  );
}

/** The `modelUsage` key the main loop's counters are filed under, if it can be told. */
function mainKey(modelUsage: ModelUsageMap, mainModel?: string): string | undefined {
  const keys = Object.entries(modelUsage ?? {})
    .filter(([, mu]) => mu && COUNTERS.some((k) => (mu[k] ?? 0) > 0))
    .map(([model]) => model);
  const matches = keys.filter(
    (model) => mainModel && (model.startsWith(mainModel) || mainModel.startsWith(model)),
  );
  return (
    keys.find((model) => model === mainModel) ??
    (matches.length === 1 ? matches[0] : undefined) ??
    (keys.length === 1 ? keys[0] : undefined)
  );
}

/** Whether a slice claims more than the main loop's own `usage` in any counter. */
function exceedsUsage(mu: ModelUsageEntry, u: NonNullable<ResultUsage["usage"]>): boolean {
  return (
    (mu.inputTokens ?? 0) > (u.input_tokens ?? 0) ||
    (mu.outputTokens ?? 0) > (u.output_tokens ?? 0) ||
    (mu.cacheReadInputTokens ?? 0) > (u.cache_read_input_tokens ?? 0) ||
    (mu.cacheCreationInputTokens ?? 0) > (u.cache_creation_input_tokens ?? 0)
  );
}

/**
 * The baseline a resumed stream's first counted result is differenced against, and whether
 * the numbers bore it out.
 *
 * Since SDK 0.3.277 a resumed stream's `modelUsage` opens at the earlier session's totals
 * rather than zero; differenced against nothing, its first turn would be billed the whole
 * earlier session — the #981 overage again, on every resume.
 *
 * `restored` is what the transcript says the SDK restored (see `restoredTotals`). It's the
 * exact baseline, so every model's slice — subagents included — comes out as this turn's
 * own. It is still checked: the main slice left over must fit the main loop's `usage`. A
 * baseline that lags what the SDK restored (a `cost-state` written after it was read, a
 * format change) fails that check, and the main model is then baselined so its slice is
 * exactly `usage` — this turn's own work. The check can't tell that from a subagent on
 * the main model, whose tokens share the main key, so such a subagent goes uncounted on
 * this one turn: an undercount, where trusting a stale baseline would bill history.
 *
 * With no `restored` (the transcript couldn't be read) there's nothing per model to
 * subtract, so the check runs on the raw counters: the main slice must fit `usage` and no
 * other model may have counters — after a model switch the old model's key carries the
 * earlier session, indistinguishable from a side-call on this turn. If either fails the
 * whole map is the baseline, pricing the turn on `usage` alone. Likewise whenever the
 * main slice can't be identified.
 */
export function resumedBaseline(
  result: ResultUsage,
  restored: ModelUsageMap,
  mainModel?: string,
): { baseline: ModelUsageMap; consistent: boolean } {
  const cur = result.modelUsage ?? {};
  const usage = result.usage ?? {};
  const main = mainKey(cur, mainModel);
  if (!main) return { baseline: cur, consistent: false };
  const mu = cur[main] ?? {};
  if (!restored) {
    const others = Object.keys(cur).filter(
      (m) => m !== main && COUNTERS.some((k) => (cur[m]?.[k] ?? 0) > 0),
    );
    return others.length > 0 || exceedsUsage(mu, usage)
      ? { baseline: cur, consistent: false }
      : { baseline: undefined, consistent: true };
  }
  const base = baselineFor(restored[main], mu);
  const slice: ModelUsageEntry = Object.fromEntries(
    COUNTERS.map((k) => [k, (mu[k] ?? 0) - (base[k] ?? 0)]),
  );
  if (!exceedsUsage(slice, usage)) return { baseline: restored, consistent: true };
  return {
    baseline: {
      ...restored,
      [main]: {
        inputTokens: Math.max(0, (mu.inputTokens ?? 0) - (usage.input_tokens ?? 0)),
        outputTokens: Math.max(0, (mu.outputTokens ?? 0) - (usage.output_tokens ?? 0)),
        cacheReadInputTokens: Math.max(
          0,
          (mu.cacheReadInputTokens ?? 0) - (usage.cache_read_input_tokens ?? 0),
        ),
        cacheCreationInputTokens: Math.max(
          0,
          (mu.cacheCreationInputTokens ?? 0) - (usage.cache_creation_input_tokens ?? 0),
        ),
      },
    },
    consistent: false,
  };
}

/** Whether a result moved any counter — a zeroed crash result says nothing about the stream. */
export function hasUsageCounters(modelUsage: ModelUsageMap): boolean {
  return Object.values(modelUsage ?? {}).some((mu) => mu && COUNTERS.some((k) => (mu[k] ?? 0) > 0));
}

/**
 * The baseline for the next turn: `prev` with this result's counters laid over it, per
 * model. Only models with a non-zero counter are taken, and a model absent from the result
 * keeps its old entry. Replacing the whole map instead would let a result that doesn't
 * list the main loop's key — a crash result, which the SDK notes may carry zeroed usage, or
 * one that only saw a side-call — wipe its baseline, and bill the next turn for the whole
 * stream (#981). A genuine reset is caught per model by `baselineFor` instead.
 */
export function advanceBaseline(prev: ModelUsageMap, modelUsage: ModelUsageMap): ModelUsageMap {
  const next = { ...prev };
  for (const [model, mu] of Object.entries(modelUsage ?? {})) {
    if (mu && COUNTERS.some((k) => (mu[k] ?? 0) > 0)) next[model] = mu;
  }
  return next;
}
