import { readFileSync, statSync } from "node:fs";
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

/**
 * Above this size, estimate from bytes instead of reading the file. Minds can
 * write arbitrarily large files under home/, and this runs synchronously per
 * mind on the status routes — a chars-accurate estimate (the point of reading)
 * only matters near the budgets, and 1MB is ~10x past the default hard cap in
 * any encoding.
 */
const MAX_READ_BYTES = 1_000_000;

/** Size + budget flags for a mind project dir's MEMORY.md. Null when the file doesn't exist. */
export function getMemoryStatus(projectDir: string): MemoryStatus | null {
  const path = resolve(projectDir, "home", "MEMORY.md");
  let bytes: number;
  let chars: number;
  try {
    const size = statSync(path).size;
    if (size > MAX_READ_BYTES) {
      bytes = size;
      chars = size;
    } else {
      const text = readFileSync(path, "utf-8");
      bytes = size;
      chars = text.length;
    }
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
  const estTokens = Math.round(chars / 4);
  return {
    bytes,
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
