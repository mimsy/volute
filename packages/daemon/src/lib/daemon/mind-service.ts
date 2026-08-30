import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { missingCredentialWarning } from "../ai-service.js";
import { syncMindProfile } from "../auth.js";
import { joinCommonsChannelForMind, joinCommonsChannelForSpirit } from "../chat/commons-channel.js";
import { ensureSystemDM } from "../chat/system-chat.js";
import { deliverEvent, hasEverReceivedEvent } from "../chat/system-events.js";
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
import { DEFAULT_SPEND_PERIOD_MINUTES, getSpendBudget } from "./spend-budget.js";

/**
 * Start a mind server and (for non-seed base minds) schedules, mail, and spend budget.
 * Variants only get the server — no schedules/budget.
 */
export async function startMindFull(name: string): Promise<void> {
  const entry = await findMind(name);
  const baseName = entry?.parent ?? name;

  // Load the spend cap BEFORE the process is registered as running. `startMind` marks
  // the mind up and then polls /health for up to 30s; a redrive sweep landing in that
  // window would find no bucket for this mind, conclude nothing is holding it, and hand
  // an over-cap mind its entire held backlog at its coldest moment.
  await restoreSpendBudget(baseName);

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
  await restoreMindRuntimeState(baseName);
  try {
    getSleepManagerIfReady()?.loadSleepConfig(baseName);
  } catch (err) {
    log.error(`failed to load sleep config for ${baseName}`, log.errorData(err));
  }
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

  // Auto-join the commons channel. Only sprouted minds reach here — seeds returned
  // early above, so they stay out of the commons until they sprout (#617).
  // warn, not error: membership self-heals (idempotent join, retried on every
  // start and by the daemon-startup backfill), so a single miss isn't fatal.
  joinCommonsChannelForMind(baseName).catch((err: unknown) =>
    log.warn(`failed to join the commons for ${baseName}`, log.errorData(err)),
  );

  try {
    notifyExtensionsMindStart(baseName);
  } catch (err) {
    log.error(`failed to notify extensions of mind start for ${baseName}`, log.errorData(err));
  }
}

/**
 * Restore the mind-owned runtime state that outlives the mind's *process*:
 * schedules and spend budget.
 *
 * `sleepMind` stops the process but deliberately keeps these — "stop process
 * only, leave schedules/budget running" — so a sleeping mind is a mind with no
 * process and a live clock. Anything that reconstructs a sleeping mind's state
 * without spawning it (daemon boot, wake) has to restore them too, or the mind
 * comes back looking healthy with a clock that holds nothing and no instrument
 * anywhere saying so (#865). Kept in one function precisely so the boot, wake,
 * and start paths cannot drift apart again.
 *
 * Sprouted base minds only. Seeds are excluded on purpose: `startMindFull`
 * returns before schedules for them, but every mind is created with a default
 * heartbeat already on disk, so a seed that slept and woke would otherwise come
 * back with a clock it was never meant to have. Variants get neither, and the
 * spirit loads its schedules with an explicit dir in `startSpiritFull`.
 */
export async function restoreMindRuntimeState(baseName: string): Promise<void> {
  const entry = await findMind(baseName);
  if (!entry || entry.parent || entry.stage === "seed") return;
  try {
    getScheduler().loadSchedules(baseName);
  } catch (err) {
    log.error(`failed to load schedules for ${baseName}`, log.errorData(err));
  }
  await restoreSpendBudget(baseName);
}

/**
 * Load a mind's spend cap into the live budget. Idempotent — re-setting the same cap
 * changes nothing — so it is safe to call both before the process starts (so the cap
 * binds from the first instant the mind is visible as running) and again from
 * {@link restoreMindRuntimeState}.
 */
export async function restoreSpendBudget(baseName: string): Promise<void> {
  const entry = await findMind(baseName);
  if (!entry || entry.parent || entry.stage === "seed") return;
  try {
    const config = readVoluteConfig(mindDir(baseName));
    if (config?.spendCap) {
      getSpendBudget().setBudget(
        baseName,
        config.spendCap,
        config.spendCapPeriodMinutes ?? DEFAULT_SPEND_PERIOD_MINUTES,
      );
    } else if (config?.tokenBudget) {
      // Budgets are denominated in dollars now, and there is no honest conversion
      // from a token count. Rather than silently enforce a number that means
      // something else, the mind runs uncapped and the host is told exactly which
      // key to replace. Repeats per boot/wake on purpose — it's a live misconfig.
      log.warn(
        `${baseName}: volute.json still sets \`tokenBudget\`, which no longer does anything. ` +
          "Budgets are dollars now — replace it with `spendCap` (USD) and " +
          "`spendCapPeriodMinutes`. Until then this mind has no spend cap.",
      );
    }
  } catch (err) {
    log.error(`failed to set spend budget for ${baseName}`, log.errorData(err));
  }
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
 * Wake a sleeping mind: start the process and restore the clock.
 *
 * Unlike `startMindFull` this is not a cold start — the mind was only asleep —
 * but its schedules and budget may have been lost with a previous daemon
 * process, so restore them here. `restoreMindRuntimeState` is idempotent, so
 * waking a mind whose clock is already live is a no-op (#865).
 */
export async function wakeMind(name: string): Promise<void> {
  await getMindManager().startMind(name);
  await restoreMindRuntimeState(name);

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
  joinCommonsChannelForSpirit().catch((err: unknown) =>
    log.error(`failed to join the commons for ${name}`, log.errorData(err)),
  );

  // Load spirit schedules with explicit dir (spirit lives outside ~/.volute/minds/)
  getScheduler().loadSchedules(name, entry?.dir ?? spiritDir());

  // The spirit is a mind as far as extensions are concerned — it has a registry
  // row, a directory, and its own pages/notes/intentions. Skipping this left it
  // with no pages worktree, so the mind whose job is tending the commons was the
  // one mind that could never publish to it (#795).
  try {
    notifyExtensionsMindStart(name);
  } catch (err) {
    log.error(`failed to notify extensions of spirit start for ${name}`, log.errorData(err));
  }

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
  notifyExtensionsMindStop(name);
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
  creatorType?: "human" | "mind" | "spirit",
): string {
  const intro = `You've just been created as a seed on ${getSystemName()}. Start a conversation — introduce yourself, ask questions, and begin exploring who you want to be.`;
  if (!createdBy) return intro;

  const who =
    creatorType === "mind"
      ? `another mind, ${createdBy}`
      : creatorType === "spirit"
        ? `the spirit of this system (${createdBy})`
        : createdBy;
  return `${intro} Your creator is ${who}. Send them a message to introduce yourself.`;
}

/**
 * Look up the creator's user_type, build the orientation message, and send it — once
 * in a mind's life.
 *
 * Orientation is a birth message ("You've just been created as a seed…"), and this runs
 * on every server start while the mind is still a seed. Without the guard a seed that
 * had been awake for hours, and had already introduced itself to its creator, was told
 * it had just been born again on the next restart (#697). The `hasUndeliveredEvent`
 * dedup used for startup notices nearby is the wrong predicate here: it goes false the
 * moment the seed reads the first orientation, which is exactly when re-sending is worst.
 */
export async function sendSeedOrientation(
  mindName: string,
  createdBy?: string | null,
): Promise<void> {
  if (await hasEverReceivedEvent(mindName, "orientation")) {
    log.info(`seed ${mindName} has already been oriented — not re-sending`);
    return;
  }
  let creatorType: "human" | "mind" | "spirit" | undefined;
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
    await getSpendBudget().removeBudget(baseName);
  }
  await getMindManager().stopMind(name);

  publishActivity({
    type: "mind_stopped",
    mind: name,
    summary: `${name} stopped`,
  }).catch((err) => log.error("failed to publish mind_stopped activity", log.errorData(err)));
}
