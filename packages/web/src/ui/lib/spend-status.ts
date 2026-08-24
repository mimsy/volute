/**
 * What the mind page's spend strip should say — pure, mirroring `chat-status.ts`.
 *
 * Two sources feed it and they measure different things, so the strip must never blend
 * them into one number:
 *
 * - `MindBudget` is the *cap period* — the window the cap actually bounds, which started
 *   whenever the period last reset and ends at `resetAt`.
 * - `UsageReport` is a *wall-clock window* (the last 24h by default), which is what a
 *   host asks when they want to know what today cost.
 *
 * When there's a cap, the cap period leads and the wall-clock window sits beside it,
 * labelled. When there isn't, the window is all there is — and it still shows, because
 * an uncapped mind is exactly the one whose spend nobody is watching.
 */

import type { MindBudget, MindUsage, UsageBucket, UsageReport, UsageTotals } from "./client";
import {
  type CapLevel,
  capLevel,
  formatPeriod,
  formatUntil,
  formatUsd,
  type SpendFigure,
  spendFigure,
} from "./spend-format";

export type SpendStrip = {
  /** The headline figure and whether it is a floor. */
  figure: SpendFigure;
  /** What the headline figure covers, e.g. "this day" or "last 24h". */
  scope: string;
  cap: {
    capUsd: number;
    percentUsed: number;
    level: CapLevel;
    /** Always rendered: a cap whose end you can't see is a trapdoor, not a budget. */
    resetsIn: string;
    resetsAt: number;
  } | null;
  /** Present only while deliveries are actually being held. */
  held: {
    scope: "mind" | "system";
    count: number;
    releasesIn: string | null;
  } | null;
  /** The install-wide cap, shown on a mind's strip only once it is worth worrying about. */
  systemCap: { percentUsed: number; level: CapLevel; resetsIn: string } | null;
  /** Spend over the wall-clock window, shown alongside a cap period that isn't the same. */
  window: { label: string; figure: SpendFigure } | null;
};

const WINDOW_LABEL: Record<UsageReport["window"], string> = {
  "24h": "last 24h",
  "7d": "last 7d",
  "30d": "last 30d",
};

/**
 * The cap period's own figure. `MindBudget` reports only whether unpriced turns
 * happened, not how many, so the note is correspondingly plainer than the window's.
 */
function periodFigure(spentUsd: number, hasUnpriced: boolean): SpendFigure {
  const text = formatUsd(spentUsd);
  if (!hasUnpriced) return { text, floor: false, note: "" };
  return {
    text,
    floor: true,
    note: `At least ${text}. Some turns this period couldn't be priced — they count nothing here and nothing against the cap.`,
  };
}

/**
 * Build the strip, or null when there is genuinely nothing to say: no cap, nothing held,
 * and not a single turn in the window.
 */
export function spendStrip(
  budget: MindBudget | null,
  usage: UsageReport | null,
  now = Date.now(),
): SpendStrip | null {
  const hasCap = budget?.capUsd != null && budget.capUsd > 0;
  const held =
    budget && budget.held.count > 0 && budget.held.scope
      ? {
          scope: budget.held.scope,
          count: budget.held.count,
          releasesIn:
            budget.held.releasesAt != null ? formatUntil(budget.held.releasesAt, now) : null,
        }
      : null;
  const turns = usage?.total.turns ?? 0;
  if (!hasCap && !held && turns === 0) return null;

  const windowFigure = usage ? spendFigure(usage.total) : null;
  const windowLabel = usage ? WINDOW_LABEL[usage.window] : "";

  if (!hasCap || !budget) {
    return {
      figure: windowFigure ?? { text: formatUsd(0), floor: false, note: "" },
      scope: windowLabel || "so far",
      cap: null,
      held,
      systemCap: systemCapOf(budget, now),
      window: null,
    };
  }

  const capUsd = budget.capUsd!;
  const percentUsed = budget.percentUsed ?? 0;
  const resetsAt = budget.resetAt ?? now;
  return {
    figure: periodFigure(budget.spentUsd ?? 0, budget.hasUnpricedTurns ?? false),
    scope: `this ${formatPeriod(budget.periodMinutes ?? 1440)}`,
    cap: {
      capUsd,
      percentUsed,
      level: capLevel(percentUsed),
      resetsIn: formatUntil(resetsAt, now),
      resetsAt,
    },
    held,
    systemCap: systemCapOf(budget, now),
    // Only worth the row when it isn't just the cap period said twice.
    window:
      windowFigure && !sameSpan(budget, usage)
        ? { label: windowLabel, figure: windowFigure }
        : null,
  };
}

/** The install-wide cap, once it is near enough to matter to this mind. */
function systemCapOf(budget: MindBudget | null, now: number) {
  const sys = budget?.system;
  if (!sys || sys.capUsd <= 0) return null;
  const level = capLevel(sys.percentUsed);
  if (level === "ok") return null;
  return { percentUsed: sys.percentUsed, level, resetsIn: formatUntil(sys.resetAt, now) };
}

/**
 * True when the cap period and the wall-clock window cover the same length of time, in
 * which case showing both is noise rather than information.
 */
function sameSpan(budget: MindBudget, usage: UsageReport | null): boolean {
  if (!usage) return true;
  const windowMinutes = usage.window === "24h" ? 1440 : usage.window === "7d" ? 10080 : 43200;
  return (budget.periodMinutes ?? 1440) === windowMinutes;
}

/** A scope that saw nothing. Spelled out so a zero is a real zero, not a missing value. */
export const EMPTY_TOTALS: UsageTotals = {
  costUsd: 0,
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  cacheHitRatio: 0,
  unpricedTurns: 0,
  preUpgradeTurns: 0,
};

export type UsageScope = {
  /** The figures the page's headline covers. */
  totals: UsageTotals;
  /** The series behind the headline. */
  series: UsageBucket[];
  /** The rows to list beneath it. */
  rows: MindUsage[];
};

/**
 * What the Usage page should show, given an optional mind to focus on.
 *
 * The case worth naming: a focused mind that recorded nothing in the window is *not*
 * the same as no focus. Falling back to the install-wide totals there would print
 * everyone's spend under one mind's name — the same misattribution the per-model
 * pricing exists to avoid. It reads as a real zero instead.
 */
export function usageScope(
  report: (UsageReport & { minds: MindUsage[] }) | null,
  focusMind: string | null,
): UsageScope {
  if (!report) return { totals: EMPTY_TOTALS, series: [], rows: [] };
  if (!focusMind) return { totals: report.total, series: report.series, rows: report.minds };
  const found = report.minds.find((m) => m.mind === focusMind);
  if (!found) return { totals: EMPTY_TOTALS, series: [], rows: [] };
  return { totals: found, series: found.series, rows: [found] };
}
