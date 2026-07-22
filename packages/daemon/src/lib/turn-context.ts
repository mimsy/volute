import type { TurnContextReason } from "@volute/extensions";
import { getTurnContextProviders } from "./extensions.js";
import log from "./util/logger.js";

const tlog = log.child("turn-context");

/**
 * Total character ceiling across *all* extensions, per collection. Not per-extension:
 * a per-extension cap sums to something unbounded as extensions are installed, which
 * is the failure mode this whole surface has to avoid.
 *
 * `turn` is deliberately small. It is paid on every single turn, competing directly
 * with the mind's own thinking, and an oversized system prompt is what drove the
 * compaction thrash this codebase already lived through. ~1200 characters is roughly
 * 300 tokens — a couple of sentences per extension, not a digest. If ambient material
 * needs more room than that, it belongs at wake.
 *
 * `wake` is paid once, after the mind has been away for hours, and is the tier the
 * design puts most of its weight on (issue #807 §3, "ambient retrospective"). ~3000
 * characters is roughly 750 tokens: enough for a real digest, still under 0.5% of a
 * 150k window.
 *
 * These are starting numbers chosen from context-cost reasoning, not from measurement
 * — there is no production data on turn context because it has never existed. They are
 * meant to be revisited against the #807 re-measure.
 */
export const TURN_CONTEXT_BUDGET: Record<TurnContextReason, number> = {
  turn: 1200,
  wake: 3000,
};

/**
 * Per-extension wall clock. A pre-prompt hook gets 5s total including `tsx` startup,
 * and this collection is one HTTP call inside that, so the whole thing has to finish
 * fast or the mind's turn waits on it.
 */
const PROVIDER_TIMEOUT_MS = 1000;

/**
 * Overall wall clock for a whole collection. Providers are asked in sequence (each
 * needs to know what the ones before it left), so a pathological set of slow
 * extensions would otherwise add up.
 *
 * This is a soft deadline, checked *between* providers: once it passes, no further
 * provider is asked, but a call already in flight still gets its full
 * `PROVIDER_TIMEOUT_MS`. Worst-case wall time is therefore
 * `TOTAL_TIMEOUT_MS + PROVIDER_TIMEOUT_MS` (~3s), not 2s. That bound is what the
 * callers are sized against: the pre-prompt hook aborts its own fetch at 3s and the
 * hook runner kills the whole script at 5s, so an overrun costs the mind a missing
 * ambient block, never a stalled turn.
 */
const TOTAL_TIMEOUT_MS = 2000;

/** Joins one extension's block to the next. Counts against the total budget. */
const SEPARATOR = "\n\n";

export type TurnContextProviderLike = {
  id: string;
  run: (budget: number) => Promise<string | null>;
};

function withTimeout(p: Promise<string | null>, ms: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Ask each provider in turn for ambient material, within a *total* budget.
 *
 * Budget policy: each provider is offered `remaining / providers-still-to-ask` — a fair
 * share of what is left. A provider that returns `null` (the normal case) donates its
 * share to the ones asked after it, so the quiet case costs nothing and a single
 * extension with something to say can still use most of the budget. No provider can
 * take more than its fair share, so one misbehaving extension cannot blow the cap for
 * everyone.
 *
 * Failure policy: a provider that throws, exceeds its budget, or runs past the deadline
 * is dropped from this collection and logged. Nothing propagates to the caller — an
 * extension must not be able to break a mind's turn. Over-budget is a drop rather than
 * a truncation on purpose: a block cut mid-sentence is worse in a mind's context than
 * no block, and dropping keeps the pressure on the extension to summarize.
 *
 * Exported separately from {@link collectTurnContext} so the policy is testable without
 * a loaded extension registry.
 */
export async function collectFromProviders(
  providers: TurnContextProviderLike[],
  reason: TurnContextReason,
  total: number = TURN_CONTEXT_BUDGET[reason],
  now: () => number = Date.now,
): Promise<string | null> {
  if (providers.length === 0 || total <= 0) return null;

  const deadline = now() + TOTAL_TIMEOUT_MS;
  const blocks: string[] = [];
  let remaining = total;

  for (let i = 0; i < providers.length; i++) {
    const { id, run } = providers[i];
    if (remaining <= 0) break;
    if (now() >= deadline) {
      tlog.warn(
        `deadline reached before asking ${providers.length - i} remaining extension(s) for ${reason} context`,
      );
      break;
    }

    // Reserve this block's joiner before dividing, so a provider that spends its whole
    // budget still leaves room for the separator that will precede it.
    const joinerCost = blocks.length > 0 ? SEPARATOR.length : 0;
    const available = remaining - joinerCost;
    if (available <= 0) break;

    const budget = Math.floor(available / (providers.length - i));
    if (budget <= 0) break;

    let text: string | null;
    try {
      text = await withTimeout(run(budget), PROVIDER_TIMEOUT_MS);
    } catch (err) {
      tlog.warn(`extension ${id}: turnContext failed, dropped from this turn`, log.errorData(err));
      continue;
    }

    if (typeof text !== "string") continue;
    const trimmed = text.trim();
    if (!trimmed) continue;

    if (trimmed.length > budget) {
      tlog.warn(
        `extension ${id}: turnContext returned ${trimmed.length} chars over a ${budget} budget — dropped`,
      );
      continue;
    }

    blocks.push(trimmed);
    // Charge the joiner too, so the cap holds on the string actually handed to the
    // mind rather than on the sum of the blocks inside it.
    remaining -= trimmed.length + joinerCost;
  }

  if (blocks.length === 0) return null;
  return blocks.join(SEPARATOR);
}

/**
 * Collect ambient turn context for a mind across every loaded extension.
 *
 * Returns `null` when nothing is around, which is the expected common case.
 *
 * **Never throws.** `collectFromProviders` contains each provider call, but the setup
 * around it (registry lookup, sort, closure construction) is guarded here too, because
 * the wake caller in SleepManager.initiateWake runs inside a try with no catch — an
 * escape there would skip markAwake() and the queue flushes and leave a mind running
 * but never marked awake. Ambient material is the least important thing in this
 * function's blast radius; it must never be the reason a mind fails to wake.
 */
export async function collectTurnContext(
  mindName: string,
  reason: TurnContextReason,
): Promise<string | null> {
  try {
    const providers = getTurnContextProviders().map(({ id, manifest, context }) => ({
      id,
      // Non-null: getTurnContextProviders filters to manifests that declare it.
      run: (budget: number) => manifest.turnContext!(mindName, context, { budget, reason }),
    }));

    return await collectFromProviders(providers, reason);
  } catch (err) {
    tlog.error(`failed to collect ${reason} context for ${mindName}`, log.errorData(err));
    return null;
  }
}
