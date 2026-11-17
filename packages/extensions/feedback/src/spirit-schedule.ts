import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionContext } from "@volute/extensions";

const MARKER_KEY = "spirit_schedule_provisioned";
const SCHEDULE_ID = "feedback-review";

/**
 * One-time bootstrap: give the spirit a daily `feedback-review` schedule, so reports
 * are reviewed without anyone remembering to ask. Provisioned once: a schedule the
 * spirit or a host later removes stays removed. Anything not ready (no spirit yet, no
 * config to merge into) is left alone and retried on the next daemon start.
 */
export async function provisionSpiritSchedule(ctx: ExtensionContext): Promise<void> {
  const db = ctx.db;
  if (!db) return;
  if (db.prepare("SELECT 1 FROM meta WHERE key = ?").get(MARKER_KEY)) return;

  const spiritName = ctx.getSpiritName();
  const spiritDir = spiritName && (await ctx.getMindDir(spiritName));
  if (!spiritDir) return;
  const configPath = resolve(spiritDir, "home/.config/volute.json");
  if (!existsSync(configPath)) return;

  let config: { schedules?: { id: string }[] };
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return;
  }
  const schedules = config.schedules ?? [];
  if (!schedules.some((s) => s.id === SCHEDULE_ID)) {
    schedules.push({
      id: SCHEDULE_ID,
      cron: "0 10 * * *",
      script: "volute feedback pending",
      enabled: true,
      whileSleeping: "skip",
    } as { id: string });
    try {
      writeFileSync(configPath, JSON.stringify({ ...config, schedules }, null, 2));
    } catch {
      return;
    }
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
    MARKER_KEY,
    new Date().toISOString(),
  );
}
