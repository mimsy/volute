import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { missingCredentialWarning } from "../ai-service.js";
import { syncMindProfile } from "../auth.js";
import { joinSystemChannelForMind, joinSystemChannelForSpirit } from "../chat/system-channel.js";
import { ensureSystemDM } from "../chat/system-chat.js";
import { deliverEvent } from "../chat/system-events.js";
import { getSystemName } from "../config/setup.js";
import { publish as publishActivity } from "../events/activity-events.js";
import { markIdle } from "../events/mind-activity-tracker.js";
import { notifyExtensionsMindStart, notifyExtensionsMindStop } from "../extensions.js";
import { findMind, getBaseName, mindDir } from "../mind/registry.js";
import { spiritDir } from "../mind/spirit.js";
import { readVoluteConfig } from "../mind/volute-config.js";
import log from "../util/logger.js";
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

  // Missing model credentials make a mind mute — its first turn fails silently inside
  // its own SDK process (#573). Record a notice so the failure is visible in
  // `mind status` and the web chat status rather than only in the mind's log. Deduped
  // per mind so repeated starts don't pile up identical notices.
  recordMissingCredentialsNotice(baseName, entry?.template).catch((err) =>
    log.error(`failed to check credentials for ${baseName}`, log.errorData(err)),
  );

  // Seed minds get the server + initial orientation, no schedules or budget
  if (!entry || entry.stage === "seed") {
    if (entry?.stage === "seed") {
      // Orientation is delivered as a system event, not a spirit DM — so bootstrap the
      // spirit↔seed DM separately (for later nurture correspondence).
      sendSeedOrientation(baseName, entry.createdBy).catch((err: unknown) =>
        log.error(`failed to send seed orientation for ${baseName}`, log.errorData(err)),
      );
      ensureSystemDM(baseName).catch((err: unknown) =>
        log.error(`failed to ensure system DM for ${baseName}`, log.errorData(err)),
      );

      // If a creator is set, ensure a DM exists between the seed and the creator
      if (entry.createdBy) {
        ensureCreatorDM(baseName, entry.createdBy).catch((err: unknown) =>
          log.error(`failed to ensure creator DM for ${baseName}`, log.errorData(err)),
        );
      }
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

  // Auto-join #system channel. Only sprouted minds reach here — seeds returned
  // early above, so they stay out of the commons until they sprout (#617).
  // warn, not error: membership self-heals (idempotent join, retried on every
  // start and by the daemon-startup backfill), so a single miss isn't fatal.
  joinSystemChannelForMind(baseName).catch((err: unknown) =>
    log.warn(`failed to join #system for ${baseName}`, log.errorData(err)),
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
 * If a mind spawned without usable model credentials, record a `no_credentials`
 * startup notice (deduped so it isn't re-added on every start). This is the
 * authoritative detection: the mind's own turn error is an opaque "process exited"
 * string, so the daemon — which knows the credentials are missing — surfaces the
 * real cause. For pi minds the provider comes from the model in the mind's SDK
 * config; if that can't be read the check is skipped rather than guessed.
 * Exported for tests.
 */
export async function recordMissingCredentialsNotice(
  mind: string,
  template: string | undefined,
): Promise<void> {
  const { hasUndeliveredEvent, recordNotice, MIND_LEVEL_THREAD } = await import(
    "../chat/system-events.js"
  );
  const warning = await missingCredentialWarning(template, readMindModel(mind, template), mind);
  if (!warning) return;
  if (await hasUndeliveredEvent(mind, "no_credentials")) return;
  await recordNotice({
    mind,
    thread: MIND_LEVEL_THREAD,
    kind: "startup",
    reason: "no_credentials",
    detail: warning,
  });
}

/**
 * The model a pi mind will actually run — from `home/.config/config.json`, the same
 * file mind-manager reads for key injection. Only pi needs it (its provider is the
 * `provider:` prefix of the model id); claude/codex resolve provider from template.
 */
function readMindModel(mind: string, template: string | undefined): string | undefined {
  if (template !== "pi") return undefined;
  try {
    const configPath = resolve(mindDir(mind), "home/.config/config.json");
    if (!existsSync(configPath)) return undefined;
    const model: unknown = JSON.parse(readFileSync(configPath, "utf-8")).model;
    return typeof model === "string" ? model : undefined;
  } catch (err) {
    log.warn(`failed to read model for ${mind}`, log.errorData(err));
    return undefined;
  }
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

/**
 * Start a spirit process. Simpler lifecycle than minds — no sleep, budget, or mail,
 * but does load schedules (for seed nurture).
 */
export async function startSpiritFull(name: string): Promise<void> {
  // Register the spirit's custom directory for routing config resolution
  const entry = await findMind(name);
  if (entry?.dir) {
    const { registerMindDir } = await import("../delivery/delivery-router.js");
    registerMindDir(name, entry.dir);
  }

  await getMindManager().startMind(name);

  // The spirit shares the commons with the minds it tends
  joinSystemChannelForSpirit().catch((err: unknown) =>
    log.error(`failed to join #system for ${name}`, log.errorData(err)),
  );

  // Load spirit schedules with explicit dir (spirit lives outside ~/.volute/minds/)
  getScheduler().loadSchedules(name, entry?.dir ?? spiritDir());

  publishActivity({
    type: "mind_started",
    mind: name,
    summary: `${name} spirit started`,
  }).catch((err) => log.error("failed to publish spirit_started activity", log.errorData(err)));
}

/**
 * Stop a spirit process.
 */
export async function stopSpiritFull(name: string): Promise<void> {
  markIdle(name);
  getScheduler().unloadSchedules(name);
  await getMindManager().stopMind(name);

  publishActivity({
    type: "mind_stopped",
    mind: name,
    summary: `${name} spirit stopped`,
  }).catch((err) => log.error("failed to publish spirit_stopped activity", log.errorData(err)));
}

/**
 * Build a seed's first orientation message. The creator can be a human, another
 * mind, or the spirit itself, so word the relationship from the creator's
 * user_type rather than assuming a human planted the seed.
 */
export function buildSeedOrientation(
  createdBy?: string | null,
  creatorType?: "human" | "mind" | "system",
): string {
  const intro = `You've just been created as a seed on ${getSystemName()}. Start a conversation — introduce yourself, ask questions, and begin exploring who you want to be.`;
  if (!createdBy) return intro;

  const who =
    creatorType === "mind"
      ? `another mind, ${createdBy}`
      : creatorType === "system"
        ? `the spirit of this system (${createdBy})`
        : createdBy;
  return `${intro} Your creator is ${who}. Send them a message to introduce yourself.`;
}

/** Look up the creator's user_type, build the orientation message, and send it. */
async function sendSeedOrientation(mindName: string, createdBy?: string | null): Promise<void> {
  let creatorType: "human" | "mind" | "system" | undefined;
  if (createdBy) {
    const { getUserByUsername } = await import("../auth.js");
    creatorType = (await getUserByUsername(createdBy))?.user_type;
  }
  await deliverEvent(mindName, {
    type: "orientation",
    body: buildSeedOrientation(createdBy, creatorType),
  });
}

async function ensureCreatorDM(mindName: string, creatorUsername: string): Promise<void> {
  const { getOrCreateMindUser, getUserByUsername } = await import("../auth.js");
  const { findDMConversation, createConversation } = await import("../events/conversations.js");

  const mindUser = await getOrCreateMindUser(mindName);
  const creatorUser = await getUserByUsername(creatorUsername);
  if (!creatorUser) {
    log.warn(`creator user '${creatorUsername}' not found for seed ${mindName} DM`);
    return;
  }

  const existing = await findDMConversation([mindUser.id, creatorUser.id]);
  if (!existing) {
    await createConversation({
      participantIds: [mindUser.id, creatorUser.id],
    });
  }
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
