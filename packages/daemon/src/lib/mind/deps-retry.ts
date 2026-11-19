import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deliverEvent, MIND_LEVEL_THREAD } from "../chat/system-events.js";
import { getMindManager, mindServerStartedAt } from "../daemon/mind-manager.js";
import { readPendingContext } from "../daemon/pending-context.js";
import { publish as publishActivity } from "../events/activity-events.js";
import log from "../util/logger.js";
import { type MergeRestartTarget, restartOntoMerge } from "./merge-restart.js";
import {
  commitDepsChanges,
  npmDepsSatisfied,
  npmInstallAsMind,
  registryReachable,
} from "./npm-install.js";
import { stateDir } from "./registry.js";

const dlog = log.child("deps-retry");

/**
 * The durable record that a mind's merged dependencies are not installed.
 *
 * An upgrade advances the template hash before its install runs, so a failed install
 * leaves a mind that nothing reads as stale — without this record nothing ever comes
 * back to it, across any number of daemon restarts (bardo, Nov 2026: an install run
 * while the network was down left two minds and the spirit on the old SDK). Written
 * when an install of merged dependencies fails; removed when one succeeds, or when a
 * check finds them installed by anyone else — the mind's own `npm install` included.
 * In `stateDir`: Volute's bookkeeping about the mind, not part of its project.
 */
function depsPendingPath(name: string): string {
  return resolve(stateDir(name), "deps-pending.json");
}

export function depsPending(name: string): boolean {
  return existsSync(depsPendingPath(name));
}

/** Record that `name`'s dependencies are not installed. Best-effort, like the alert beside it. */
export function markDepsPending(name: string): void {
  try {
    mkdirSync(stateDir(name), { recursive: true });
    writeFileSync(
      depsPendingPath(name),
      `${JSON.stringify({ since: new Date().toISOString() })}\n`,
    );
  } catch (err) {
    dlog.warn(`failed to record ${name}'s pending dependency install`, log.errorData(err));
  }
}

export function clearDepsPending(name: string): void {
  try {
    rmSync(depsPendingPath(name), { force: true });
  } catch (err) {
    dlog.warn(`failed to clear ${name}'s pending dependency install`, log.errorData(err));
  }
}

/** When npm last finished installing into `dir`: it rewrites its hidden lockfile on every install. */
function installedAt(dir: string): number | null {
  try {
    return statSync(resolve(dir, "node_modules", ".package-lock.json")).mtimeMs;
  } catch {
    return null;
  }
}

export type DepsRetryDeps = {
  satisfied: (dir: string, name: string) => Promise<boolean>;
  reachable: () => Promise<boolean>;
  install: (dir: string, name: string) => Promise<void>;
  commitDeps: (dir: string, name: string, message: string) => Promise<boolean>;
  getManager: () => MergeRestartTarget & {
    isRunning(name: string): boolean;
    hasPendingRecovery(name: string): boolean;
    resumeRecovery(name: string): Promise<void>;
  };
  /** Host-facing alert: a dashboard row. */
  publishHostError: (name: string, summary: string, kind: string) => Promise<void>;
  isAsleep?: (name: string) => boolean;
  /** When the mind's running server started (epoch ms), or null. */
  serverStartedAt: (name: string) => number | null;
  /** When npm last installed into the mind's tree (epoch ms), or null. */
  installedAt: (dir: string) => number | null;
  readPendingContext: (name: string) => Record<string, unknown> | null;
  /** Tell the mind something on its next turn. */
  notify: (name: string, text: string) => Promise<void>;
};

const defaultDeps: DepsRetryDeps = {
  satisfied: npmDepsSatisfied,
  reachable: () => registryReachable(),
  install: (dir, name) => npmInstallAsMind(dir, name),
  commitDeps: commitDepsChanges,
  getManager: getMindManager,
  publishHostError: async (name, summary, kind) => {
    await publishActivity({ type: "mind_error", mind: name, summary, metadata: { kind } });
  },
  serverStartedAt: mindServerStartedAt,
  installedAt,
  readPendingContext,
  notify: async (name, text) => {
    await deliverEvent(name, {
      type: "notice",
      body: text,
      meta: { subtype: "upgrade_deps_resolved" },
      delivery: "next-turn",
      thread: MIND_LEVEL_THREAD,
    });
  },
};

/**
 * What {@link retryPendingDeps} did: `held` when an install was needed but the caller
 * said not to attempt one, `unreachable` when the registry could not be resolved (no
 * install was attempted), `failed` with the install's error.
 */
export type DepsRetryOutcome =
  | "none"
  | "satisfied"
  | "installed"
  | "held"
  | "unreachable"
  | { failed: unknown };

/**
 * Finish a dependency install an upgrade could not, for a mind with the pending record.
 *
 * 1. Already installed — by the mind, a host, anyone: clear the record and commit
 *    whatever that install changed in the package files. Checked with
 *    `npm ls` rather than by reinstalling, because even a no-op install can freeze slow
 *    storage for a minute. A mind whose running process started before that install
 *    still has the old packages loaded; it is *told*, not restarted. It ran (or was
 *    handed) the install itself, so it is already in the loop and can pick its moment —
 *    and its next sleep and wake picks the packages up anyway.
 * 2. Otherwise, only when the registry resolves: an install now would fail the same way,
 *    after minutes of npm's fetch backoff on storage that can least afford it.
 * 3. On success: commit what npm changed in the package files, as the upgrade does, and
 *    restart a running mind onto the packages through the same sleep-aware restart an
 *    upgrade uses. A stopped or sleeping mind is left for its next start, and told.
 *
 * Never throws for an install failure — that is the `failed` outcome, for the caller to
 * report once. The caller holds the mind's upgrade lock.
 */
export async function retryPendingDeps(
  name: string,
  dir: string,
  opts: { install: boolean },
  deps: DepsRetryDeps = defaultDeps,
): Promise<DepsRetryOutcome> {
  if (!depsPending(name)) return "none";
  const manager = deps.getManager();

  if (await deps.satisfied(dir, name)) {
    clearDepsPending(name);
    dlog.info(`${name}'s dependencies are installed; clearing its pending install`);
    // A hand-run install rewrites the lockfile too; leave the tree clean (#1385).
    await commitDeps(dir, name, deps);
    if (dropUnheardFailure(name, manager, deps)) return "satisfied";
    const started = deps.serverStartedAt(name);
    const installed = deps.installedAt(dir);
    if (manager.isRunning(name) && started !== null && installed !== null && started < installed) {
      await deps.notify(
        name,
        "The dependencies your framework upgrade needed are installed now — but your running " +
          "process started before that install, so it still has the old packages loaded. They " +
          "take effect at your next start: your next sleep and wake will do it, or run " +
          `\`volute mind restart ${name}\` whenever suits you.`,
      );
    }
    return "satisfied";
  }

  if (!opts.install) return "held";
  if (!(await deps.reachable())) return "unreachable";

  try {
    await deps.install(dir, name);
  } catch (err) {
    return { failed: err };
  }
  clearDepsPending(name);
  dlog.info(`installed ${name}'s pending dependencies`);
  await commitDeps(dir, name, deps);

  if (dropUnheardFailure(name, manager, deps)) return "installed";
  const resolvedText =
    "The dependencies your framework upgrade needed, which failed to install at the time, " +
    "are installed now.";
  if (manager.isUpOrRecovering(name)) {
    const wasRecovering = manager.hasPendingRecovery(name);
    try {
      const restarted = await restartOntoMerge(
        manager,
        name,
        { type: "restart", depsResolved: `${resolvedText} This restart puts you on them.` },
        { healthTimeoutMs: 120_000, isAsleep: deps.isAsleep },
      );
      // Asleep: the context waits on disk for the wake's start, which delivers it.
      if (restarted === "asleep") {
        dlog.info(`${name} is asleep; it starts on its new packages at wake`);
      }
    } catch (err) {
      // As after an upgrade (installDepsAndRestart): the stop cancelled any pending
      // crash recovery, and a start that never got healthy registered none — so this
      // row is the only thing that says the mind is down. The context stays on disk.
      if (wasRecovering) {
        await manager.resumeRecovery(name).catch((e) => {
          dlog.warn(`failed to resume crash recovery for ${name}`, log.errorData(e));
        });
      }
      const detail = (err instanceof Error ? err.message : String(err)).split("\n")[0];
      await deps.publishHostError(
        name,
        `Installed ${name}'s pending dependencies but it failed to restart — the mind is down: ${detail}`,
        "upgrade_restart_failed",
      );
    }
  } else {
    await deps.notify(name, `${resolvedText} You run on them from your next start.`);
  }
  return "installed";
}

/** Commit what an install changed in the package files, as the mind. Never throws. */
async function commitDeps(dir: string, name: string, deps: DepsRetryDeps): Promise<void> {
  await deps
    .commitDeps(dir, name, "Install dependencies left over from upgrade")
    .catch((err) =>
      dlog.warn(`failed to commit dependency changes for ${name}`, log.errorData(err)),
    );
}

/**
 * A mind that never started since the failed install still has the failure waiting in
 * its pending context. Take it out — telling a mind about a failure and its fix at once
 * is noise — and report that nothing else needs saying.
 */
function dropUnheardFailure(
  name: string,
  manager: MergeRestartTarget,
  deps: DepsRetryDeps,
): boolean {
  const pending = deps.readPendingContext(name);
  if (!pending?.depsFailure) return false;
  const { depsFailure: _, ...rest } = pending;
  manager.setPendingContext(name, rest);
  return true;
}
