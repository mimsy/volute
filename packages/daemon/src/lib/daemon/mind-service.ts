import { missingCredentialWarning } from "../ai-service.js";
import { syncMindProfile } from "../auth.js";
import { joinSystemChannelForMind, joinSystemChannelForSpirit } from "../chat/system-channel.js";
import { ensureSystemDM, sendSystemMessage } from "../chat/system-chat.js";
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
      // sendSeedOrientation calls ensureSystemDM internally (via sendSystemMessage)
      sendSeedOrientation(baseName, entry.createdBy).catch((err: unknown) =>
        log.error(`failed to send seed orientation for ${baseName}`, log.errorData(err)),
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
 * If a mind spawned without usable model credentials, record a `no_credentials`
 * startup notice (deduped so it isn't re-added on every start). This is the
 * authoritative detection: the mind's own turn error is an opaque "process exited"
 * string, so the daemon — which knows the credentials are missing — surfaces the
 * real cause. Template is used to pick the provider; a pi mind's model isn't passed,
 * so pi minds (already guarded at create) are skipped when the provider is ambiguous.
 */
async function recordMissingCredentialsNotice(
  mind: string,
  template: string | undefined,
): Promise<void> {
  const { hasUndeliveredNotice, recordNotice, MIND_LEVEL_SESSION } = await import("./notices.js");
  const warning = await missingCredentialWarning(template, undefined, mind);
  if (!warning) return;
  if (await hasUndeliveredNotice(mind, "no_credentials")) return;
  await recordNotice({
    mind,
    session: MIND_LEVEL_SESSION,
    kind: "startup",
    reason: "no_credentials",
    detail: warning,
  });
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
  creatorType?: "brain" | "mind" | "system",
): string {
  const intro =
    "You've just been created as a seed. Start a conversation — introduce yourself, ask questions, and begin exploring who you want to be.";
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
  let creatorType: "brain" | "mind" | "system" | undefined;
  if (createdBy) {
    const { getUserByUsername } = await import("../auth.js");
    creatorType = (await getUserByUsername(createdBy))?.user_type;
  }
  await sendSystemMessage(mindName, buildSeedOrientation(createdBy, creatorType));
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
