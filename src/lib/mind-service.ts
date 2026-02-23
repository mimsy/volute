import { publish as publishActivity } from "./activity-events.js";
import { getConnectorManager } from "./connector-manager.js";
import log from "./logger.js";
import { ensureMailAddress } from "./mail-poller.js";
import { getMindManager } from "./mind-manager.js";
import { startWatcher, stopWatcher } from "./pages-watcher.js";
import { findMind, mindDir } from "./registry.js";
import { getScheduler } from "./scheduler.js";
import { DEFAULT_BUDGET_PERIOD_MINUTES, getTokenBudget } from "./token-budget.js";
import { readVoluteConfig } from "./volute-config.js";

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
export async function stopMindFull(name: string): Promise<void> {
  const [baseName, variantName] = name.split("@", 2);

  if (!variantName) {
    stopWatcher(baseName);
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
