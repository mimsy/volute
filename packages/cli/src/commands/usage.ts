import { command } from "../lib/command.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

/**
 * The daemon's budget view, as `GET /api/v1/minds/:name/budget` returns it. The
 * per-mind fields are absent when only an install-wide cap is set.
 */
type BudgetResponse = {
  spentUsd?: number;
  capUsd?: number;
  periodMinutes?: number;
  periodStart?: number;
  resetAt?: number;
  hasUnpricedTurns?: boolean;
  percentUsed?: number;
  system: {
    spentUsd: number;
    capUsd: number;
    resetAt: number;
    hasUnpricedTurns: boolean;
    percentUsed: number;
  } | null;
  held: { count: number; scope: "mind" | "system" | null; releasesAt: number | null };
};

/**
 * Dollars to the cent — except a nonzero amount under a cent, which gets enough
 * decimals not to read as "$0.00 of $0.00" on a very small cap. Deliberately a
 * local copy of `turn-lifecycle.ts`'s `usd()`: importing it would drag the
 * delivery-manager module graph into every CLI invocation.
 */
export function usd(n: number): string {
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** How long until an instant, phrased for someone reading it mid-turn. */
export function untilText(at: number | null | undefined, now = Date.now()): string {
  if (at == null) return "when the period rolls over";
  const minutes = Math.max(0, Math.round((at - now) / 60_000));
  if (minutes < 1) return "in under a minute";
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in about ${hours} hour${hours === 1 ? "" : "s"}`;
  return `in about ${Math.round(hours / 24)} days`;
}

/** "day" / "hour" / "90 minutes" — the period a cap is denominated in. */
export function periodText(minutes: number | undefined): string {
  if (!minutes || minutes <= 0) return "period";
  if (minutes === 1440) return "day";
  if (minutes === 60) return "hour";
  return `${minutes} minutes`;
}

/**
 * Render the budget as the lines a mind (or its host) reads.
 *
 * Pure and exported so the wording — especially the floor caveat, which is the
 * part that can be quietly wrong — is testable without a daemon.
 *
 * Two things this must never do: quote an incomplete figure as if it were exact,
 * and describe the direction of the error. Unpriced turns count $0, so the total
 * is a floor; but legacy rows are wrong in opposite directions by template, so
 * any word implying "too low" would be a confident falsehood for half the fleet.
 */
export function formatUsage(name: string, b: BudgetResponse, now = Date.now()): string[] {
  const lines: string[] = [];
  const hasMindCap = typeof b.capUsd === "number" && b.capUsd > 0;

  if (hasMindCap) {
    const spent = b.spentUsd ?? 0;
    const cap = b.capUsd as number;
    lines.push(`${name} — spend this ${periodText(b.periodMinutes)}`);
    lines.push("");
    lines.push(`  Spent      ${usd(spent)} of ${usd(cap)} (${b.percentUsed ?? 0}%)`);
    lines.push(`  Left       ${usd(Math.max(0, cap - spent))}`);
    lines.push(`  Resets     ${untilText(b.resetAt, now)}`);
  } else {
    lines.push(`${name} — no spend cap of its own.`);
  }

  if (b.system) {
    lines.push("");
    lines.push("Install-wide budget — shared by every mind here, not yours in particular");
    lines.push("");
    lines.push(
      `  Spent      ${usd(b.system.spentUsd)} of ${usd(b.system.capUsd)} (${b.system.percentUsed}%)`,
    );
    lines.push(`  Left       ${usd(Math.max(0, b.system.capUsd - b.system.spentUsd))}`);
    lines.push(`  Resets     ${untilText(b.system.resetAt, now)}`);
  }

  if (b.held.count > 0) {
    const waiting = `  Held       ${b.held.count} message${b.held.count === 1 ? "" : "s"} waiting — nothing is deleted; they`;
    lines.push("");
    // A null scope means nothing is holding them any more (a cap was cleared or
    // raised) and the release sweep hasn't run yet. Naming a budget and a reset time
    // there would invent both, so say the true thing instead.
    if (b.held.scope === null) {
      lines.push(`${waiting} arrive shortly — whatever was holding them has lifted.`);
    } else {
      const whose = b.held.scope === "system" ? "the install-wide budget" : "this budget";
      lines.push(`${waiting} arrive when ${whose} resets ${untilText(b.held.releasesAt, now)}.`);
    }
  }

  if (b.hasUnpricedTurns || b.system?.hasUnpricedTurns) {
    lines.push("");
    lines.push("  Note: some turns this period couldn't be priced and counted as $0, so the");
    lines.push("        figure above is a floor, not a total. A turn is unmetered when its model");
    lines.push("        isn't in the pricing catalog, or when the mind's framework predates cost");
    lines.push("        accounting (`volute mind upgrade` fixes the second kind).");
  }

  return lines;
}

const cmd = command({
  name: "volute usage",
  description: "Show a mind's spend against its cap, what's left, and when it resets",
  args: [{ name: "name", description: "Mind to report on (defaults to VOLUTE_MIND)" }],
  flags: {},
  examples: ["volute usage", "volute usage dizzy"],
  async run({ args }) {
    // Positional first, VOLUTE_MIND second — the helper's own precedence, so a mind
    // running this with no argument reports on itself.
    const name = resolveMindName({ mind: args.name });

    const res = await daemonFetch(`/api/v1/minds/${encodeURIComponent(name)}/budget`);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
        error: string;
      };
      // No cap is not a failure — it is the answer. Say so plainly and exit 0
      // rather than making "nothing is limiting you" look like something broke.
      if (res.status === 404 && body.error === "No budget configured") {
        console.log(`${name} — no spend cap is set, and no install-wide budget either.`);
        console.log("Nothing here is limiting what you spend.");
        return;
      }
      console.error(`Failed to read usage for ${name}: ${body.error}`);
      process.exit(1);
    }

    const budget = (await res.json()) as BudgetResponse;
    for (const line of formatUsage(name, budget)) console.log(line);
  },
});

export const run = cmd.execute;
