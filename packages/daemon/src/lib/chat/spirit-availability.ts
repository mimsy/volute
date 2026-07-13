import { getSpiritName, isSetupComplete } from "../config/setup.js";
import { getMindManager } from "../daemon/mind-manager.js";
import { startSpiritFull } from "../daemon/mind-service.js";
import { getSleepManagerIfReady } from "../daemon/sleep-manager.js";
import { findMind } from "../mind/registry.js";
import log from "../util/logger.js";

const slog = log.child("spirit-availability");

/**
 * The system spirit's availability for receiving a message:
 * - `running`  — up and reachable now.
 * - `sleeping` — asleep; the sleep queue delivers on wake (don't force-wake, per #418).
 * - `waking`   — was stopped and has just been started on demand; a reply is coming.
 * - `unavailable` — the spirit cannot exist (setup incomplete or project creation failed);
 *   nothing will answer, so the caller should surface an honest notice instead of silence.
 */
export type SpiritStatus = "running" | "sleeping" | "waking" | "unavailable";

/**
 * The spirit's current state, before any on-demand start. `stopped` is the one state that
 * warrants starting it; `cannot-exist` is terminal (no spirit project can serve the message).
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
};

export type SpiritAvailability = {
  status: SpiritStatus;
  /** Present only when `status === "unavailable"`: the honest sentence to show the sender. */
  notice?: string;
};

const SETUP_INCOMPLETE_NOTICE =
  "The system spirit isn't available (setup is incomplete). An admin can finish setup in Settings.";
const CREATION_FAILED_NOTICE =
  "The system spirit isn't available (it failed to start). An admin can check the daemon logs and Settings.";

/**
 * Pure classification of the spirit's state from gathered inputs — no side effects, so the
 * on-demand-start decision (running/sleeping/stopped/cannot-exist) is unit-testable.
 */
export function classifySpiritState(i: SpiritStateInputs): SpiritState {
  if (!i.setupComplete || !i.spiritExists) return "cannot-exist";
  if (i.sleeping) return "sleeping";
  if (i.running) return "running";
  return "stopped";
}

/** The honest "unavailable" sentence, worded for the actual cause. */
export function spiritUnavailableNotice(setupComplete: boolean): string {
  return setupComplete ? CREATION_FAILED_NOTICE : SETUP_INCOMPLETE_NOTICE;
}

/**
 * Resolve the spirit's availability for an incoming message and, if it exists but is
 * stopped, start it on demand. Awaiting the start means a subsequent fan-out sees the
 * spirit running and delivers directly (rather than dropping the message).
 *
 * The spirit is system machinery the daemon owns: a stopped/crashed spirit should not be
 * a silent UX cliff. A sleeping spirit is left alone — sleeping ≠ stopped, and its queue
 * covers the message. Only a spirit that *cannot exist* yields `unavailable` + a notice.
 */
export async function ensureSpiritAvailable(): Promise<SpiritAvailability> {
  const setupComplete = isSetupComplete();
  const spiritName = getSpiritName();
  const entry = setupComplete ? await findMind(spiritName) : undefined;
  const sm = getSleepManagerIfReady();
  const manager = getMindManager();

  const state = classifySpiritState({
    setupComplete,
    spiritExists: !!entry,
    sleeping: !!sm?.isSleeping(spiritName),
    running: manager.isRunning(spiritName),
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
        await startSpiritFull(spiritName);
        return { status: "waking" };
      } catch (err) {
        // A concurrent request may have won the start race (mind-manager serializes starts
        // and throws "already running" for the loser) — in that case it's up now.
        if (manager.isRunning(spiritName)) return { status: "running" };
        slog.warn("failed to start spirit on demand", log.errorData(err));
        return { status: "unavailable", notice: spiritUnavailableNotice(setupComplete) };
      }
  }
}
