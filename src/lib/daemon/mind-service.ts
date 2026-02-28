import { findMind, mindDir } from "@volute/shared/registry";
import { readVoluteConfig } from "@volute/shared/volute-config";
import { publish as publishActivity } from "../events/activity-events.js";
import { markIdle } from "../events/mind-activity-tracker.js";
import log from "../logger.js";
import { startWatcher, stopWatcher } from "../pages-watcher.js";
import { getConnectorManager } from "./connector-manager.js";
import { ensureMailAddress } from "./mail-poller.js";
import { getMindManager } from "./mind-manager.js";
import { getScheduler } from "./scheduler.js";
import { DEFAULT_BUDGET_PERIOD_MINUTES, getTokenBudget } from "./token-budget.js";

/**
 * Start a mind server and (for non-seed base minds) connectors, schedules, mail, and token budget.
 * Variants only get the server — no connectors/schedules/budget.
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

  // Seed minds only get the server — no connectors, schedules, or budget
  const entry = findMind(baseName);
  if (!entry || entry.stage === "seed") return;

  const dir = mindDir(baseName);
  const daemonPort = process.env.VOLUTE_DAEMON_PORT
    ? parseInt(process.env.VOLUTE_DAEMON_PORT, 10)
    : undefined;
  await getConnectorManager().startConnectors(baseName, dir, entry.port, daemonPort);
  getScheduler().loadSchedules(baseName);
  ensureMailAddress(baseName).catch((err: unknown) =>
    log.error(`failed to ensure mail address for ${baseName}`, log.errorData(err)),
  );
  const config = readVoluteConfig(dir);
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
 * Stop a mind server and (for non-variant minds) connectors, schedules, and budget.
 */
/**
 * Put a mind to sleep: stop process only, leave connectors/schedules/budget running.
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
 * Wake a sleeping mind: start process only (connectors are already running).
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
    await getConnectorManager().stopConnectors(baseName);
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
