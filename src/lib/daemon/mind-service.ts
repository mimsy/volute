import { syncMindProfile } from "../auth.js";
import { publish as publishActivity } from "../events/activity-events.js";
import { markIdle } from "../events/mind-activity-tracker.js";
import { notifyExtensionsMindStart, notifyExtensionsMindStop } from "../extensions.js";
import log from "../logger.js";
import { findMind, getBaseName, mindDir } from "../registry.js";
import { joinSystemChannelForMind } from "../system-channel.js";
import { ensureSystemDM, sendSystemMessage } from "../system-chat.js";
import { readVoluteConfig } from "../volute-config.js";
import { ensureMailAddress } from "./mail-poller.js";
import { getMindManager } from "./mind-manager.js";
import { getScheduler } from "./scheduler.js";
import { getSleepManagerIfReady } from "./sleep-manager.js";
import { DEFAULT_BUDGET_PERIOD_MINUTES, getTokenBudget } from "./token-budget.js";

/**
 * Start a mind server and (for non-seed base minds) schedules, mail, and token budget.
 * Variants only get the server — no schedules/budget.
 */
export async function startMindFull(name: string): Promise<void> {
  const entry = await findMind(name);
  const baseName = entry?.parent ?? name;

  await getMindManager().startMind(name);

  publishActivity({
    type: "mind_started",
    mind: name,
    summary: `${name} started`,
  }).catch((err) => log.error("failed to publish mind_started activity", log.errorData(err)));

  if (entry?.parent) return;

  // Seed minds get the server + initial orientation, no schedules or budget
  if (!entry || entry.stage === "seed") {
    if (entry?.stage === "seed") {
      // sendSystemMessage calls ensureSystemDM internally
      sendSystemMessage(
        baseName,
        "You've just been created. A human planted you as a seed. Start a conversation with them — introduce yourself, ask questions, and begin exploring who you want to be.",
      ).catch((err: unknown) =>
        log.error(`failed to send seed orientation for ${baseName}`, log.errorData(err)),
      );
    } else {
      ensureSystemDM(baseName).catch((err: unknown) =>
        log.error(`failed to ensure system DM for ${baseName}`, log.errorData(err)),
      );
    }
    return;
  }

  // Ensure system DM conversation exists (for sprouted minds)
  ensureSystemDM(baseName).catch((err: unknown) =>
    log.error(`failed to ensure system DM for ${baseName}`, log.errorData(err)),
  );

  const dir = mindDir(baseName);
  getScheduler().loadSchedules(baseName);
  getSleepManagerIfReady()?.loadSleepConfig(baseName);
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

  notifyExtensionsMindStart(baseName);
}

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
  const baseName = await getBaseName(name);
  const isBase = baseName === name;

  if (isBase) {
    notifyExtensionsMindStop(baseName);
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
