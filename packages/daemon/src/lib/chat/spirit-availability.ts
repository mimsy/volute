import { computeSetupStatus, type GlobalConfig, readGlobalConfigStrict } from "../config/setup.js";
import { MindStartupError, tryGetMindManager } from "../daemon/mind-manager.js";
import { startSpiritFull } from "../daemon/mind-service.js";
import { getSleepManagerIfReady } from "../daemon/sleep-manager.js";
import { findMind } from "../mind/registry.js";
import { spiritCreationInProgress } from "../mind/spirit.js";
import log from "../util/logger.js";

const slog = log.child("spirit-availability");

/**
 * The system spirit's availability for receiving a message:
 * - `running`  — up and reachable now.
 * - `sleeping` — asleep; the sleep queue delivers on wake (don't force-wake, per #418).
 * - `waking`   — was stopped and has just been started on demand; a reply is coming.
 * - `unavailable` — the spirit cannot exist or cannot stay up (setup incomplete, project
 *   creation failed, crash-looping); nothing will answer, so the caller should surface an
 *   honest notice instead of silence.
 */
export type SpiritStatus = "running" | "sleeping" | "waking" | "unavailable";

/**
 * The spirit's current state, before any on-demand start. `stopped` is the one state that
 * warrants starting it; `cannot-exist` is terminal (no spirit can serve the message).
 */
export type SpiritState = "running" | "sleeping" | "stopped" | "cannot-exist";

export type SpiritStateInputs = {
  /** Setup finished (provider + model), so a spirit is allowed to exist. */
  setupComplete: boolean;
  /** The spirit is registered (its project was created). */
  spiritExists: boolean;
  /** The spirit is asleep. */
  sleeping: boolean;
  /** The spirit process is running. */
  running: boolean;
  /**
   * The spirit recently failed to stay up: crash recovery exhausted its attempts, or an
   * on-demand start moments ago is already dead again. Starting it yet again would report
   * "waking" forever — classify as cannot-exist and be honest instead.
   */
  recentlyFailed?: boolean;
};

export type SpiritAvailability = {
  status: SpiritStatus;
  /** Present only when `status === "unavailable"`: the honest sentence to show the sender. */
  notice?: string;
};

/** Stable prefix shared by every unavailable notice — used for dedupe across rewordings. */
export const SPIRIT_NOTICE_PREFIX = "The system spirit isn't available";

const SETUP_INCOMPLETE_NOTICE = `${SPIRIT_NOTICE_PREFIX} (setup is incomplete). An admin can finish setup in Settings.`;
const CREATION_FAILED_NOTICE = `${SPIRIT_NOTICE_PREFIX} (it failed to start). An admin can check the daemon logs and Settings.`;

/**
 * Pure classification of the spirit's state from gathered inputs — no side effects, so the
 * on-demand-start decision (running/sleeping/stopped/cannot-exist) is unit-testable.
 */
export function classifySpiritState(i: SpiritStateInputs): SpiritState {
  if (!i.setupComplete || !i.spiritExists) return "cannot-exist";
  if (i.sleeping) return "sleeping";
  if (i.running) return "running";
  if (i.recentlyFailed) return "cannot-exist";
  return "stopped";
}

/** The honest "unavailable" sentence, worded for the actual cause. */
export function spiritUnavailableNotice(setupComplete: boolean): string {
  return setupComplete ? CREATION_FAILED_NOTICE : SETUP_INCOMPLETE_NOTICE;
}

/**
 * When the last on-demand start was attempted. If the spirit is dead again within this
 * window it boots-then-crashes; report unavailable instead of restarting on every DM
 * (which would also keep resetting the crash tracker's give-up counter).
 */
let lastOnDemandStartAt = 0;
const ON_DEMAND_RETRY_COOLDOWN_MS = 60_000;

/** Reset module state (for tests). */
export function _resetSpiritAvailabilityState(): void {
  lastOnDemandStartAt = 0;
}

/**
 * Resolve the spirit's availability for an incoming message and, if it exists but is
 * stopped, start it on demand. Awaiting the start means a subsequent fan-out sees the
 * spirit running and delivers directly (rather than dropping the message).
 *
 * ADVISORY, and never throws: this check must never block or break message delivery, and
 * it must never produce a confident notice from an unconfident read. Returns `null`
 * (indeterminate — caller shows no status and persists no notice) when:
 * - the mind/sleep managers aren't initialized yet (daemon-boot window; without the sleep
 *   manager a sleeping spirit would misread as stopped and be force-started past #418),
 * - the global config can't be parsed (torn read of a non-atomic write),
 * - setup is complete but the spirit project is still being created.
 *
 * A sleeping spirit is left alone — sleeping ≠ stopped, and its queue covers the message.
 * Only a spirit that confidently *cannot exist* (or cannot stay up) yields `unavailable`
 * plus an honest notice.
 */
export async function ensureSpiritAvailable(): Promise<SpiritAvailability | null> {
  try {
    // Daemon-boot window: the web server listens before subsystems initialize.
    const manager = tryGetMindManager();
    const sleepManager = getSleepManagerIfReady();
    if (!manager || !sleepManager) return null;

    // Strict config read: readGlobalConfig() swallows parse errors into `{}`, which would
    // classify a running spirit as "setup incomplete" off a torn read.
    let config: GlobalConfig;
    try {
      config = readGlobalConfigStrict();
    } catch (err) {
      slog.warn("global config unreadable — spirit availability indeterminate", {
        ...log.errorData(err),
      });
      return null;
    }
    const setupComplete = computeSetupStatus(config) === "complete";
    const spiritName = config.setup?.spiritName ?? "volute";

    const entry = setupComplete ? await findMind(spiritName) : undefined;

    // Setup complete but no registry row while creation is in flight (daemon boot or the
    // setup finale, which can spend minutes in npm install) — not a failure yet.
    if (setupComplete && !entry && spiritCreationInProgress()) return null;

    const recentlyFailed =
      manager.hasExhaustedRestarts(spiritName) ||
      (lastOnDemandStartAt > 0 && Date.now() - lastOnDemandStartAt < ON_DEMAND_RETRY_COOLDOWN_MS);

    const state = classifySpiritState({
      setupComplete,
      spiritExists: !!entry,
      sleeping: sleepManager.isSleeping(spiritName),
      running: manager.isRunning(spiritName),
      recentlyFailed,
    });

    switch (state) {
      case "cannot-exist":
        return { status: "unavailable", notice: spiritUnavailableNotice(setupComplete) };
      case "sleeping":
        return { status: "sleeping" };
      case "running":
        return { status: "running" };
      case "stopped":
        // Exists, awake, but stopped → start it so it can reply.
        try {
          lastOnDemandStartAt = Date.now();
          await startSpiritFull(spiritName);
          return { status: "waking" };
        } catch (err) {
          // A concurrent request may have won the start race (mind-manager serializes
          // starts and throws "already running" for the loser) — it's up, all good.
          if (err instanceof Error && err.message.includes("already running")) {
            return { status: "running" };
          }
          if (manager.isRunning(spiritName)) {
            // The process started but post-start wiring (e.g. schedule loading) failed —
            // the spirit is up but degraded. Trace it loudly; a reply is still coming.
            slog.error("spirit started on demand but post-start setup failed", {
              ...log.errorData(err),
            });
            return { status: "waking" };
          }
          // A failed on-demand start is a production defect: log at ERROR with the
          // captured child stderr (the notice tells admins to check the daemon logs).
          slog.error("failed to start spirit on demand", {
            ...log.errorData(err),
            ...(err instanceof MindStartupError ? { stderr: err.stderr } : {}),
          });
          return { status: "unavailable", notice: spiritUnavailableNotice(setupComplete) };
        }
    }
  } catch (err) {
    // Advisory only: an availability failure must never take message delivery down.
    slog.error("spirit availability check failed", { ...log.errorData(err) });
    return null;
  }
}
