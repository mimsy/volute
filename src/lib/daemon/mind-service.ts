import { syncMindProfile } from "../auth.js";
import { publish as publishActivity } from "../events/activity-events.js";
import { markIdle } from "../events/mind-activity-tracker.js";
import log from "../logger.js";
import { startWatcher, stopWatcher } from "../pages-watcher.js";
import { findMind, mindDir } from "../registry.js";
import { joinSystemChannelForMind } from "../system-channel.js";
import { readVoluteConfig } from "../volute-config.js";
import { ensureMailAddress } from "./mail-poller.js";
import { getMindManager } from "./mind-manager.js";
import { getScheduler } from "./scheduler.js";
import { DEFAULT_BUDGET_PERIOD_MINUTES, getTokenBudget } from "./token-budget.js";

/**
 * Start a mind server and (for non-seed base minds) schedules, mail, and token budget.
 * Variants only get the server — no schedules/budget.
 */
export async function startMindFull(name: string): Promise<void> {
  const [baseName, variantName] = name.split("@", 2);

  await getMindManager().startMind(name);

  publishActivity({
    type: "mind_started",
    mind: name,
    summary: `${name} started`,
  }).catch((err) => log.error("failed to publish mind_started activity", log.errorData(err)));

  if (variantName) return;

  // Seed minds only get the server — no schedules or budget
  const entry = findMind(baseName);
  if (!entry || entry.stage === "seed") return;

  const dir = mindDir(baseName);
  getScheduler().loadSchedules(baseName);
  ensureMailAddress(baseName).catch((err: unknown) =>
    log.error(`failed to ensure mail address for ${baseName}`, log.errorData(err)),
  );
  const config = readVoluteConfig(dir);

  // Sync mind profile from volute.json into the users table
  if (config) {
    syncMindProfile(baseName, config.profile ?? {}).catch((err: unknown) =>
      log.error(`failed to sync profile for ${baseName}`, log.errorData(err)),
    );
  }

  // Auto-join #system channel
  joinSystemChannelForMind(baseName).catch((err: unknown) =>
    log.error(`failed to join #system for ${baseName}`, log.errorData(err)),
  );

  if (config?.tokenBudget) {
    getTokenBudget().setBudget(
      baseName,
      config.tokenBudget,
      config.tokenBudgetPeriodMinutes ?? DEFAULT_BUDGET_PERIOD_MINUTES,
    );
  }

  startWatcher(baseName);
}

/**
 * Stop a mind server and (for non-variant minds) schedules and budget.
 */
/**
 * Put a mind to sleep: stop process only, leave schedules/budget running.
 */
export async function sleepMind(name: string): Promise<void> {
  markIdle(name);
  await getMindManager().stopMind(name);

  publishActivity({
    type: "mind_sleeping",
    mind: name,
    summary: `${name} is sleeping`,
  }).catch((err) => log.error("failed to publish mind_sleeping activity", log.errorData(err)));
}

/**
 * Wake a sleeping mind: start process only.
 */
export async function wakeMind(name: string): Promise<void> {
  await getMindManager().startMind(name);

  publishActivity({
    type: "mind_waking",
    mind: name,
    summary: `${name} is waking`,
  }).catch((err) => log.error("failed to publish mind_waking activity", log.errorData(err)));
}

export async function stopMindFull(name: string): Promise<void> {
  const [baseName, variantName] = name.split("@", 2);

  if (!variantName) {
    stopWatcher(baseName);
    markIdle(baseName);
    getScheduler().unloadSchedules(baseName);
    getTokenBudget().removeBudget(baseName);
  }
  await getMindManager().stopMind(name);

  publishActivity({
    type: "mind_stopped",
    mind: name,
    summary: `${name} stopped`,
  }).catch((err) => log.error("failed to publish mind_stopped activity", log.errorData(err)));
}
