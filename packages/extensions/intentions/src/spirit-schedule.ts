import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Database, ExtensionContext } from "@volute/extensions";

const MARKER_KEY = "spirit_schedule_provisioned";
const SCHEDULE_ID = "intention-review";
const REVIEW_SCRIPT = "volute intentions review-due";

/**
 * Scripts an earlier version provisioned that name a CLI noun the dispatcher never
 * registered — an extension's noun is its manifest id (`intentions`, plural), and this
 * shipped as the singular. A schedule carrying one of these fails every morning with
 * `Unknown command: intention`, unsupervised, and nothing retries it: provisioning is
 * once-only, so the bad string would outlive the fix that corrected the constant.
 *
 * Correcting it in place is self-limiting — once no host carries an old string this
 * list (and the repair branch below) can be deleted.
 */
const LEGACY_REVIEW_SCRIPTS = [
  "volute intention review-due", // cli-noun-exempt: the broken name this repairs
];

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
 * "Provision once, respect deletion": once the marker is set, a *missing* schedule is
 * never re-created — if the spirit or a host deleted it on purpose, it stays gone.
 * The marker only gets set after a successful write, so a system whose spirit
 * doesn't exist yet (or whose config is missing/unparseable/unwritable) is
 * left alone and retried on the next daemon start.
 *
 * An *existing* schedule is still repaired past the marker, though — see
 * LEGACY_REVIEW_SCRIPTS. Deletion is a decision worth respecting; a broken command
 * string is not, and once-only provisioning means nothing else would ever fix it.
 */
export async function provisionSpiritSchedule(ctx: ExtensionContext): Promise<void> {
  if (!ctx.db) return;
  // Deliberately not an early return on the marker: an already-provisioned host may be
  // carrying a stale script that only this pass can repair. The marker still decides
  // whether a missing schedule gets created.
  const provisioned = isProvisioned(ctx.db);

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
  const existing = schedules.find((s) => s.id === SCHEDULE_ID);
  let dirty = false;

  if (existing) {
    // Repair, not overwrite: only a script string we know we mis-shipped gets corrected,
    // so a spirit that deliberately rewrote its own review command keeps it.
    if (typeof existing.script === "string" && LEGACY_REVIEW_SCRIPTS.includes(existing.script)) {
      existing.script = REVIEW_SCRIPT;
      dirty = true;
    }
  } else if (!provisioned) {
    schedules.push({
      id: SCHEDULE_ID,
      cron: "0 9 * * *",
      script: REVIEW_SCRIPT,
      enabled: true,
      whileSleeping: "skip",
    });
    dirty = true;
  }

  if (dirty) {
    try {
      writeFileSync(configPath, JSON.stringify({ ...config, schedules }, null, 2));
    } catch {
      return; // couldn't write — try again next boot
    }
  }

  if (!provisioned) markProvisioned(ctx.db);
}
