import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Database, ExtensionContext } from "@volute/extensions";

const MARKER_KEY = "spirit_schedule_provisioned";
const SCHEDULE_ID = "intention-review";

/** Minimal shape of a schedules entry in a mind's home/.config/volute.json. */
type ScheduleEntry = {
  id: string;
  cron?: string;
  script?: string;
  enabled: boolean;
  whileSleeping?: "skip" | "queue" | "trigger-wake";
  [key: string]: unknown;
};

type VoluteConfigLike = {
  schedules?: ScheduleEntry[];
  [key: string]: unknown;
};

function isProvisioned(db: Database): boolean {
  return !!db.prepare("SELECT 1 FROM meta WHERE key = ?").get(MARKER_KEY);
}

function markProvisioned(db: Database): void {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
    MARKER_KEY,
    new Date().toISOString(),
  );
}

/**
 * One-time bootstrap: give the spirit a daily `intention-review` schedule so
 * the review lifecycle has ignition without anyone remembering to run
 * `volute clock add` — the same failure mode ("nothing ever triggers it")
 * that left the old plan extension inert.
 *
 * "Provision once, respect deletion": once the marker is set, this never runs
 * again — even if the spirit or a host later deletes the schedule on purpose.
 * The marker only gets set after a successful write, so a system whose spirit
 * doesn't exist yet (or whose config is missing/unparseable/unwritable) is
 * left alone and retried on the next daemon start.
 */
export async function provisionSpiritSchedule(ctx: ExtensionContext): Promise<void> {
  if (!ctx.db || isProvisioned(ctx.db)) return;

  const spiritName = ctx.getSpiritName();
  if (!spiritName) return; // no spirit configured yet

  // Registry-backed lookup — the spirit's directory is under the system dir, not
  // the minds dir, so a path-convention resolve finds nothing and skips forever.
  const spiritDir = await ctx.getMindDir(spiritName);
  if (!spiritDir) return; // spirit not created yet — try again next boot

  const configPath = resolve(spiritDir, "home/.config/volute.json");
  if (!existsSync(configPath)) return; // nothing to safely merge into yet

  let config: VoluteConfigLike;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return; // unparseable — don't guess, don't clobber, try again next boot
  }

  const schedules = config.schedules ?? [];
  if (!schedules.some((s) => s.id === SCHEDULE_ID)) {
    schedules.push({
      id: SCHEDULE_ID,
      cron: "0 9 * * *",
      script: "volute intentions review-due",
      enabled: true,
      whileSleeping: "skip",
    });
    try {
      writeFileSync(configPath, JSON.stringify({ ...config, schedules }, null, 2));
    } catch {
      return; // couldn't write — try again next boot
    }
  }

  markProvisioned(ctx.db);
}
