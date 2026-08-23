/**
 * Pricing for the per-turn `usage` events minds emit.
 *
 * Templates report tokens; only the daemon knows the model catalog, so cost is attached
 * here, once, on receipt — and persisted with the `mind_history` row. That freezes each
 * turn at the price in effect when it ran: a later catalog update never rewrites history.
 *
 * The unit is USD. pi-ai's catalog quotes **USD per million tokens** (verified against
 * v0.80.6: `claude-haiku-4-5` → `{input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25}`),
 * so every rate is divided by 1e6.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModel, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { findMind, mindDir } from "../mind/registry.js";
import log from "../util/logger.js";

const plog = log.child("usage-pricing");

/** USD-per-million rates, as the catalog quotes them. */
export type CostRates = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/** A model id, with its catalog provider when one could be attributed. */
export type ModelRef = { provider?: string; id: string };

/** The token counts a turn used. `cacheRead`/`cacheCreation` are absent for un-upgraded minds. */
export type UsageTokens = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
};

/**
 * The provider a template's model ids belong to when the id carries no `provider:` prefix.
 * pi is absent on purpose: its model ids are always prefixed, so an unprefixed one is
 * genuinely unresolvable rather than defaulting to a guess.
 */
const TEMPLATE_PROVIDER: Record<string, string> = {
  claude: "anthropic",
  codex: "openai",
};

/**
 * Fallback model per template, used only when the mind's own `home/.config/config.json`
 * can't be read. Mirrors the `model` field of each template's shipped config.json.
 */
const TEMPLATE_DEFAULT_MODEL: Record<string, string> = {
  claude: "claude-opus-4-6",
  codex: "gpt-5.4",
  pi: "openrouter:moonshotai/kimi-k2.5",
};

/** Whether the catalog knows this provider — the test for "is this prefix really a provider?". */
function isKnownProvider(provider: string): boolean {
  return (getBuiltinModels(provider as never) as unknown[]).length > 0;
}

/**
 * Split a model reference into provider and id.
 *
 * A `provider:id` prefix wins (pi's format, and the format a mind's config.json uses) —
 * but only when the catalog actually knows that provider. Not every colon is a provider
 * separator: a Bedrock or Vertex deployment id looks like
 * `us.anthropic.claude-opus-4-6-20260115-v1:0`, and splitting it would mangle the id down
 * to `0` and stamp the mangled form into history for later surfaces to display. When the
 * prefix isn't a provider the id is kept whole and the provider comes from the template.
 *
 * The provider can end up undefined — an id we can't attribute to a catalog. That is a
 * recorded fact (the id survives, the cost is null), not a guess.
 */
export function parseModelRef(model: string | undefined, template?: string): ModelRef | null {
  if (!model) return null;
  const colon = model.indexOf(":");
  if (colon > 0) {
    const provider = model.slice(0, colon);
    if (isKnownProvider(provider)) return { provider, id: model.slice(colon + 1) };
  }
  return { provider: template ? TEMPLATE_PROVIDER[template] : undefined, id: model };
}

/** Render a ref the way it is stamped into history: `provider:id`, or the bare id. */
export function formatModelRef(ref: ModelRef): string {
  return ref.provider ? `${ref.provider}:${ref.id}` : ref.id;
}

/**
 * The catalog rates for a model, or null when the model is unknown or unpriced.
 *
 * Providers hand back dated ids (`claude-sonnet-4-5-20250929`) that the catalog may not
 * carry verbatim, so an exact miss falls back to the longest catalog id the given id
 * extends at a `-` boundary — `claude-opus-4-6-20260115` resolves to `claude-opus-4-6`,
 * while `gpt-5.9` does *not* silently resolve to `gpt-5`.
 *
 * "Unpriced" is `input === 0 && output === 0` together — what `buildCustomModel` produces
 * for a host-added model. A single zero field is not enough: `openai/gpt-4` legitimately
 * has `cacheRead: 0`.
 */
export function lookupRates(ref: ModelRef): CostRates | null {
  if (!ref.provider) return null;
  let model = getBuiltinModel(ref.provider as never, ref.id as never) as Model<Api> | undefined;
  if (!model) {
    let best: Model<Api> | undefined;
    for (const candidate of getBuiltinModels(ref.provider as never) as Model<Api>[]) {
      if (!ref.id.startsWith(`${candidate.id}-`)) continue;
      if (!best || candidate.id.length > best.id.length) best = candidate;
    }
    model = best;
  }
  if (!model) return null;
  const cost = model.cost;
  if (cost.input === 0 && cost.output === 0) return null;
  return {
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cacheRead,
    cacheWrite: cost.cacheWrite,
  };
}

/**
 * Cost of a turn in USD.
 *
 * Tiered pricing (`ModelCost.tiers`, e.g. gpt-5.4 above 272k input tokens) is deliberately
 * ignored: tiers apply per *request*, and a usage event is a per-*turn* aggregate over
 * however many requests the tool loop made, so no tier can be picked correctly from it.
 * The base rate is the honest approximation.
 */
export function costOf(rates: CostRates, tokens: UsageTokens): number {
  return (
    (tokens.input * rates.input +
      tokens.output * rates.output +
      (tokens.cacheRead ?? 0) * rates.cacheRead +
      (tokens.cacheCreation ?? 0) * rates.cacheWrite) /
    1_000_000
  );
}

/** What a priced usage event carries on top of its token counts. */
export type UsagePricing = {
  /** Turn cost in USD, or null when the model is unknown, unpriced, or the counts are partial. */
  cost_usd: number | null;
  /** `provider:id` of the model the turn was priced against — or the bare id, unattributed. */
  model?: string;
  /**
   * True when the template that emitted this event predates cache accounting, so the
   * token counts are missing cache reads/writes. Such a turn is left unpriced rather than
   * given a number that is wrong by an order of magnitude, and surfaces label it as such.
   *
   * Note this flag does *not* yet gate the token budget: `turn-lifecycle.ts` still records
   * a partial turn's input/output against it. The budget becomes dollar-denominated in the
   * spend-cap PR, which is where `partial` starts being consulted.
   */
  partial?: boolean;
};

/** One model's slice of a turn, as the templates emit it. */
type ModelSlice = {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

/** Read `metadata.models` if it carries a usable per-model breakdown. */
function readModelSlices(value: unknown): ModelSlice[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const slices: ModelSlice[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return undefined;
    const s = raw as Record<string, unknown>;
    if (typeof s.model !== "string") return undefined;
    slices.push({
      model: s.model,
      input_tokens: num(s.input_tokens) ?? 0,
      output_tokens: num(s.output_tokens) ?? 0,
      cache_read_input_tokens: num(s.cache_read_input_tokens) ?? 0,
      cache_creation_input_tokens: num(s.cache_creation_input_tokens) ?? 0,
    });
  }
  return slices;
}

/**
 * Sum a per-model breakdown, each slice at its own model's rates.
 *
 * All-or-nothing: one unpriceable slice takes the whole turn unpriced. A sum missing a
 * model's share is not a cheaper turn, it is a wrong number, and nothing downstream could
 * tell the two apart.
 */
function priceSlices(
  slices: ModelSlice[],
  ctx: { mind?: string; template?: string },
): number | null {
  let total = 0;
  for (const slice of slices) {
    const ref = parseModelRef(slice.model, ctx.template);
    const rates = ref && lookupRates(ref);
    if (!rates) {
      plog.warn(
        `no pricing for ${slice.model}${ctx.mind ? ` (${ctx.mind})` : ""} — recording the turn without cost`,
      );
      return null;
    }
    total += costOf(rates, {
      input: slice.input_tokens,
      output: slice.output_tokens,
      cacheRead: slice.cache_read_input_tokens,
      cacheCreation: slice.cache_creation_input_tokens,
    });
  }
  return total;
}

/** Read a metadata field as a finite number, or undefined when absent/unusable. */
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Price a usage event's metadata, returning the fields to merge into it.
 *
 * `metadata` is exactly what the mind sent. Absence is meaningful throughout: a missing
 * cache field means "this mind's template doesn't report it", not zero.
 */
export function priceUsageMetadata(
  metadata: Record<string, unknown>,
  ctx: { mind?: string; template?: string; configuredModel?: string },
): UsagePricing {
  const cacheRead = num(metadata.cache_read_input_tokens);
  const cacheCreation = num(metadata.cache_creation_input_tokens);
  const slices = readModelSlices(metadata.models);
  // A breakdown only comes from a template that reports cache, so its presence rules out
  // the legacy two-field shape even if the aggregate cache fields were somehow dropped.
  const partial = !slices && cacheRead === undefined && cacheCreation === undefined;

  const declared = typeof metadata.model === "string" ? metadata.model : undefined;
  const ref =
    parseModelRef(declared, ctx.template) ??
    parseModelRef(ctx.configuredModel, ctx.template) ??
    parseModelRef(ctx.template ? TEMPLATE_DEFAULT_MODEL[ctx.template] : undefined, ctx.template);

  const result: UsagePricing = { cost_usd: null };
  if (partial) result.partial = true;
  if (!ref) {
    plog.warn(
      `no model for usage event${ctx.mind ? ` from ${ctx.mind}` : ""} — recording tokens without cost`,
    );
    return result;
  }
  result.model = formatModelRef(ref);

  // A partial turn keeps its resolved model (surfaces name it) but stays unpriced: cache
  // reads are most of a long-running mind's throughput, so pricing input+output alone
  // would understate the bill by orders of magnitude.
  if (partial) return result;

  // Prefer the per-model breakdown: a turn spanning a main model and a cheaper side-call
  // has a true cost that no single-model attribution can express.
  if (slices) {
    result.cost_usd = priceSlices(slices, ctx);
    return result;
  }

  const rates = lookupRates(ref);
  if (!rates) {
    plog.warn(`no pricing for ${result.model} — recording tokens without cost`);
    return result;
  }
  result.cost_usd = costOf(rates, {
    input: num(metadata.input_tokens) ?? 0,
    output: num(metadata.output_tokens) ?? 0,
    cacheRead,
    cacheCreation,
  });
  return result;
}

/**
 * The template and configured model for a mind, used to resolve an event that names no
 * model of its own. Read per usage event (one per turn, so a row lookup and a small file
 * read), rather than cached, so an upgrade or a model change takes effect immediately.
 */
export async function mindPricingContext(
  mind: string,
): Promise<{ mind: string; template?: string; configuredModel?: string }> {
  const entry = await findMind(mind);
  const template = entry?.template;
  let configuredModel: string | undefined;
  try {
    // Honour the registry's `dir` — variants live in git worktrees and spirits can sit in a
    // custom setup dir, so `mindDir()` alone would miss the config and silently fall through
    // to the template default, pricing the turn against a model the mind never ran.
    const dir = entry?.dir ?? mindDir(mind);
    const raw = await readFile(resolve(dir, "home/.config/config.json"), "utf-8");
    const model: unknown = JSON.parse(raw).model;
    if (typeof model === "string") configuredModel = model;
  } catch {
    // No readable config (a variant mid-setup, a mind whose dir moved) — fall back to the
    // template default below. Not worth a warning per turn.
  }
  return { mind, template, configuredModel };
}
