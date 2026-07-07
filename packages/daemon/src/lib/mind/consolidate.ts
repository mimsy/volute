import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { aiCompleteUtility } from "../ai-service.js";
import log from "../util/logger.js";

const cLog = log.child("consolidate");

/**
 * Upper bound on daily-log characters fed to the model, so a mind with a huge
 * backlog of logs can't blow the context window. Roughly ~50k tokens at 4
 * chars/token, leaving ample room for the system prompt and the output. When
 * the logs exceed this, the most recent entries are kept.
 */
export const MAX_CONSOLIDATION_INPUT_CHARS = 200_000;

/** Read non-empty daily logs (YYYY-MM-DD.md) from a mind's memory dir, oldest first. */
export function readDailyLogs(memoryDir: string): string[] {
  let files: string[];
  try {
    files = readdirSync(memoryDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort();
  } catch {
    return [];
  }
  const logs: string[] = [];
  for (const filename of files) {
    const date = filename.replace(".md", "");
    const content = readFileSync(resolve(memoryDir, filename), "utf-8").trim();
    if (content) logs.push(`### ${date}\n\n${content}`);
  }
  return logs;
}

/**
 * Join the daily logs (oldest first) into a single block bounded by maxChars.
 * The most recent whole logs that fit within the budget are kept; older ones
 * are dropped. If not even the most recent log fits, its tail is truncated so
 * the result is always within the bound.
 */
export function boundLogText(logs: string[], maxChars = MAX_CONSOLIDATION_INPUT_CHARS): string {
  const kept: string[] = [];
  let total = 0;
  for (let i = logs.length - 1; i >= 0; i--) {
    const len = logs[i].length + (kept.length > 0 ? 2 : 0); // "\n\n" separator
    if (total + len > maxChars) break;
    kept.unshift(logs[i]);
    total += len;
  }
  if (kept.length === 0 && logs.length > 0) {
    return logs[logs.length - 1].slice(-maxChars);
  }
  return kept.join("\n\n");
}

/**
 * One-shot memory consolidation. Reads daily logs from a mind directory and
 * produces consolidated MEMORY.md content via the system AI service (the same
 * utility model used for turn summaries), so it works for any template and
 * isn't pinned to a retired model. No-ops if no logs exist or no model is
 * configured. The `complete` param is injectable for testing.
 */
export async function consolidateMemory(
  mindDir: string,
  complete: (system: string, user: string) => Promise<string | null> = aiCompleteUtility,
): Promise<void> {
  const soulPath = resolve(mindDir, "home/SOUL.md");
  const memoryPath = resolve(mindDir, "home/MEMORY.md");
  const memoryDir = resolve(mindDir, "home/memory");

  const soul = readFileSync(soulPath, "utf-8");
  const logs = readDailyLogs(memoryDir);

  if (logs.length === 0) {
    cLog.info("No daily logs found; skipping memory consolidation.");
    return;
  }

  cLog.info("Consolidating memory from daily logs...");

  const userMessage = [
    "You have daily logs from a previous environment but no long-term memory file yet.",
    "Please review the daily logs below and produce consolidated MEMORY.md content.",
    "Keep it concise and organized by topic. Output ONLY the markdown content for MEMORY.md, nothing else.",
    "",
    "## Daily logs",
    "",
    boundLogText(logs),
  ].join("\n");

  const content = (await complete(soul, userMessage))?.trim();
  if (content) {
    writeFileSync(memoryPath, `${content}\n`);
    cLog.info("MEMORY.md created successfully.");
  } else {
    cLog.warn("No content produced; skipping memory consolidation.");
  }
}
