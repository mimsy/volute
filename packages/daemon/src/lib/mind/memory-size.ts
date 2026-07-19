import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * MEMORY.md is inlined into a mind's system prompt on every request, so its size
 * is a per-request token cost. The daemon reads the file directly (rather than
 * asking the mind server) so size is visible even for stopped minds and minds on
 * stale templates. Defaults and the chars/4 estimate mirror
 * templates/_base/src/lib/startup.ts (guarded by test/memory-size.test.ts); a
 * mind can override both budgets via `memory` in home/.config/config.json.
 */
export const MEMORY_SOFT_BUDGET_TOKENS = 5000;
export const MEMORY_HARD_CAP_TOKENS = 25000;

export type MemoryStatus = {
  bytes: number;
  /** Estimated tokens (chars / 4 — the same estimate the mind's template uses). */
  estTokens: number;
  softBudgetTokens: number;
  hardCapTokens: number;
  /** Over the soft budget — a consolidation nudge is warranted. */
  overBudget: boolean;
  /** Over the hard cap — the mind's template loads only the head of the file. */
  overHardCap: boolean;
};

/** Size + budget flags for a mind project dir's MEMORY.md. Null when the file doesn't exist. */
export function getMemoryStatus(projectDir: string): MemoryStatus | null {
  let text: string;
  try {
    text = readFileSync(resolve(projectDir, "home", "MEMORY.md"), "utf-8");
  } catch {
    return null;
  }

  let softBudgetTokens = MEMORY_SOFT_BUDGET_TOKENS;
  let hardCapTokens = MEMORY_HARD_CAP_TOKENS;
  try {
    const config = JSON.parse(
      readFileSync(resolve(projectDir, "home", ".config", "config.json"), "utf-8"),
    );
    if (typeof config?.memory?.softBudgetTokens === "number") {
      softBudgetTokens = config.memory.softBudgetTokens;
    }
    if (typeof config?.memory?.hardCapTokens === "number") {
      hardCapTokens = config.memory.hardCapTokens;
    }
  } catch {
    // Missing or malformed config — use defaults.
  }

  // Chars, not bytes: byte counts overestimate multibyte (CJK/emoji) content and
  // would flag truncation the template isn't actually performing.
  const estTokens = Math.round(text.length / 4);
  return {
    bytes: Buffer.byteLength(text),
    estTokens,
    softBudgetTokens,
    hardCapTokens,
    overBudget: estTokens > softBudgetTokens,
    overHardCap: estTokens > hardCapTokens,
  };
}

/** "~13.3k tokens" / "~800 tokens" — shared formatting for status output. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `~${tokens} tokens`;
  return `~${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k tokens`;
}
