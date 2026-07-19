import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * MEMORY.md is inlined into a mind's system prompt on every request, so its size
 * is a per-request token cost. The daemon reads the file directly (rather than
 * asking the mind server) so size is visible even for stopped minds and minds on
 * stale templates. Defaults mirror templates/_base/src/lib/startup.ts; a mind can
 * override both via `memory` in home/.config/config.json.
 */
export const MEMORY_SOFT_BUDGET_TOKENS = 5000;
export const MEMORY_HARD_CAP_TOKENS = 25000;

export type MemoryStatus = {
  bytes: number;
  /** Estimated tokens (bytes / 4). */
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
  let bytes: number;
  try {
    bytes = statSync(resolve(projectDir, "home", "MEMORY.md")).size;
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

  const estTokens = Math.round(bytes / 4);
  return {
    bytes,
    estTokens,
    softBudgetTokens,
    hardCapTokens,
    overBudget: estTokens > softBudgetTokens,
    overHardCap: estTokens > hardCapTokens,
  };
}

/** "~13k tokens" / "~800 tokens" — shared formatting for status output. */
export function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `~${Math.round(tokens / 1000)}k tokens` : `~${tokens} tokens`;
}
