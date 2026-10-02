import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { checkMissingBridgeEnv, getBridgeDef } from "../bridges/bridge-defs.js";
import { readBridgesConfig } from "../bridges/bridges.js";
import { readEnv, sharedEnvPath } from "../config/env.js";
import { daemonLoopback, voluteSystemDir } from "../mind/registry.js";
import log from "../util/logger.js";
import { resolveWithinBase } from "../util/paths.js";
import { type ProcessIdentity, processIdentity } from "../util/process-identity.js";
import { RotatingLog } from "../util/rotating-log.js";
import { voluteRoot } from "../util/volute-root.js";
import { ManagerNotReadyError } from "./manager-not-ready.js";
import { RestartTracker } from "./restart-tracker.js";

const blog = log.child("bridges");

/** The built bridge script for a platform, under Volute's root, or null if it isn't there. */
export function resolveBuiltinBridge(
  platform: string,
  root: string | null = voluteRoot(),
): string | null {
  if (!root) return null;
  const script = resolve(root, "dist", "connectors", `${platform}-bridge.js`);
  return existsSync(script) ? script : null;
}

/**
 * What a bridge's PID file records: its pid, and when it started, in which boot. A file
 * from before #1360 holds a bare pid, and so neither.
 */
type BridgePidRecord = { pid: number; start: string | null; boot: string | null };

type TrackedBridge = {
  child: ChildProcess;
  platform: string;
};

function unknownPlatform(platform: string): Error {
  return new Error(`Unknown bridge platform: ${platform}`);
}

export class BridgeManager {
  private bridges = new Map<string, TrackedBridge>();
  private shuttingDown = false;
  private restartTracker = new RestartTracker();
  /**
   * Crash restarts waiting out their backoff. The crashed child is already gone from
   * `bridges` by then, so this is the only handle a disable has on the respawn (#1352).
   */
  private pendingRestarts = new Map<string, NodeJS.Timeout>();
  /**
   * Each platform's starts and stops, run one at a time in call order — every one to
   * completion, the old child's exit included, before the next begins. Whatever was
   * asked last is what holds, without each operation reasoning about the others.
   */
  private ops = new Map<string, Promise<void>>();
  /** SIGTERM-to-SIGKILL grace when stopping, and when replacing a running bridge. */
  private stopGraceMs = 5000;
  private replaceGraceMs = 3000;
  /** How long to wait for the exit a SIGKILL should bring before giving up on it. */
  private killWaitMs = 2000;
  /**
   * Every child spawned and not yet exited, with its platform — tracked or not (one a
   * replacing start is still terminating, say).
   */
  private live = new Map<ChildProcess, string>();

  async startBridges(daemonPort: number): Promise<void> {
    const config = readBridgesConfig();
    const platforms = Object.entries(config)
      .filter(([, cfg]) => cfg.enabled)
      .map(([platform]) => platform);

    await Promise.all(
      platforms.map((platform) =>
        this.startBridge(platform, daemonPort).catch((err) => {
          blog.warn(`failed to start bridge ${platform}`, log.errorData(err));
        }),
      ),
    );
  }

  checkBridgeEnv(
    platform: string,
  ): { missing: { name: string; description: string }[]; bridgeName: string } | null {
    const def = getBridgeDef(platform);
    if (!def) return null;

    const env = readEnv(sharedEnvPath());
    const missing = checkMissingBridgeEnv(def, env);
    if (missing.length === 0) return null;

    return {
      missing: missing.map((v) => ({ name: v.name, description: v.description })),
      bridgeName: def.displayName,
    };
  }

  /**
   * `configure` runs first inside this platform's queue — the caller's config write, so
   * config and process state change together and can't be interleaved with another
   * caller's start or stop.
   */
  startBridge(platform: string, daemonPort: number, configure?: () => void): Promise<void> {
    if (!this.knownPlatform(platform)) return Promise.reject(unknownPlatform(platform));
    return this.serialize(platform, async () => {
      if (this.shuttingDown) {
        blog.info(`not starting bridge ${platform} — the daemon is shutting down`);
        return;
      }
      configure?.();
      await this.doStartBridge(platform, daemonPort);
    });
  }

  /** `deconfigure` runs once the bridge is stopped, inside the same queue slot. */
  stopBridge(platform: string, deconfigure?: () => void): Promise<void> {
    if (!this.knownPlatform(platform)) return Promise.reject(unknownPlatform(platform));
    // Cancelled now as well as when the stop runs: a restart timer firing while this
    // stop waits its turn would otherwise queue a start behind it (#1352).
    this.cancelPendingRestart(platform);
    return this.serialize(platform, async () => {
      await this.doStopBridge(platform);
      deconfigure?.();
    });
  }

  private serialize(platform: string, op: () => Promise<void>): Promise<void> {
    const run = (this.ops.get(platform) ?? Promise.resolve()).then(op);
    this.ops.set(
      platform,
      run.catch(() => {}),
    );
    return run;
  }

  private async doStartBridge(platform: string, daemonPort: number): Promise<void> {
    // This start supersedes any pending crash restart, which would otherwise kill it.
    this.cancelPendingRestart(platform);

    // Replace the running bridge, if any. The kill is deliberate, so its exit must not
    // count as a crash — that would spend a restart attempt and schedule a restart that
    // then kills the replacement.
    const existing = this.bridges.get(platform);
    if (existing) await this.terminate(platform, existing.child, this.replaceGraceMs);

    // Kill orphan from previous daemon session
    await this.killOrphanBridge(platform);

    // Resolve bridge script (built-in only for now)
    const builtinBridge = this.resolveBuiltinBridge(platform);
    if (!builtinBridge) {
      throw new Error(`No bridge code found for platform: ${platform}`);
    }

    // Set up log file
    const logsDir = resolve(voluteSystemDir(), "logs");
    mkdirSync(logsDir, { recursive: true });
    const logStream = new RotatingLog(resolve(logsDir, `bridge-${platform}.log`));

    // Pass platform-specific env vars from shared env
    const sharedEnv = readEnv(sharedEnvPath());
    const prefix = `${platform.toUpperCase()}_`;
    const platformEnv = Object.fromEntries(
      Object.entries(sharedEnv).filter(([k]) => k.startsWith(prefix)),
    );

    // Read daemon token from process env
    const daemonToken = process.env.VOLUTE_DAEMON_TOKEN;
    if (!daemonToken) {
      throw new Error(`Cannot start bridge ${platform}: VOLUTE_DAEMON_TOKEN not set`);
    }

    const spawnOpts: SpawnOptions = {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: {
        ...process.env,
        VOLUTE_DAEMON_URL: `http://${daemonLoopback()}:${daemonPort}`,
        VOLUTE_DAEMON_TOKEN: daemonToken,
        VOLUTE_BRIDGE_PLATFORM: platform,
        ...platformEnv,
      },
    };

    const child = spawn(process.execPath, [builtinBridge], spawnOpts);
    child.on("error", (err) => blog.error(`bridge ${platform} process error`, log.errorData(err)));
    if (!child.pid) {
      // Failed outright (the runtime vanished, say): no process, and no 'exit' to come.
      throw new Error(`failed to spawn bridge ${platform}`);
    }

    let lastStderr = "";
    child.stdout?.pipe(logStream);
    child.stderr?.on("data", (chunk: Buffer) => {
      logStream.write(chunk);
      lastStderr = chunk.toString().trim();
    });

    // The pid now, so a crash before its identity is read still leaves a handle on it.
    this.writeBridgePid(platform, { pid: child.pid, start: null, boot: null });
    this.live.set(child, platform);
    this.bridges.set(platform, { child, platform });
    // Clear the crash budget only once this spawn has proved it can stay up —
    // resetting here at spawn time let a bridge that dies immediately refresh its
    // own budget forever, so it never backed off and never gave up (#1033).
    this.restartTracker.armHealthyReset(platform);

    // This child's exit handler is the one owner of its lifecycle: whoever ended it,
    // it untracks this child and its PID file, and only then decides whether it crashed.
    child.on("exit", (code) => {
      // The leader is gone; anything left in its group (a process it spawned that shrugged
      // off SIGTERM) goes now, while the group's id still can't have been reused.
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // ESRCH: nothing left in the group — the clean case
        }
      }
      this.live.delete(child);
      const current = this.bridges.get(platform)?.child === child;
      if (current) {
        // This spawn died before it earned a reset — keep its accumulated count.
        // Scoped to the tracked child so a stale child's late exit can't cancel
        // the reset armed by the spawn that replaced it.
        this.restartTracker.cancelHealthyReset(platform);
        this.bridges.delete(platform);
      }
      if (child.pid && this.readBridgePid(platform)?.pid === child.pid) {
        this.removeBridgePid(platform);
      }

      // Only the tracked child can crash: one we killed or replaced was untracked first.
      if (!current || this.shuttingDown) return;

      blog.error(`bridge ${platform} exited with code ${code}`);
      if (lastStderr) blog.warn(`bridge ${platform} last output: ${lastStderr}`);

      const { shouldRestart, delay, attempt } = this.restartTracker.recordCrash(platform);
      if (!shouldRestart) {
        blog.error(`bridge ${platform} crashed ${attempt} times — giving up`);
        return;
      }

      blog.info(
        `restarting bridge ${platform} — attempt ${attempt}/${this.restartTracker.maxRestartAttempts}, in ${delay}ms`,
      );
      this.scheduleRestart(platform, daemonPort, delay);
    });

    await this.saveBridgeIdentity(platform, child);
    blog.info(`started bridge ${platform}`);
  }

  private async doStopBridge(platform: string): Promise<void> {
    // A crashed bridge waiting out its backoff is untracked, so the pending restart is
    // the only thing left to stop (#1352).
    const cancelled = this.cancelPendingRestart(platform);
    // Every child of this platform still alive, so a stop returns only once it's gone.
    const children = [...this.live].filter(([, p]) => p === platform).map(([c]) => c);
    await Promise.all(children.map((c) => this.terminate(platform, c, this.stopGraceMs)));

    // Also covers a bridge that gave up after crashing: nothing alive, nothing pending,
    // but its budget is spent.
    this.restartTracker.reset(platform);
    // Off means off for a bridge an earlier daemon left running, too. (Our own children's
    // PID files are their exit handlers' to remove; this leaves those alone.)
    await this.killOrphanBridge(platform);
    if (children.length > 0 || cancelled) blog.info(`stopped bridge ${platform}`);
  }

  /**
   * Kill `child` on purpose and wait for it to exit: SIGTERM, then SIGKILL after
   * `graceMs`, then a short wait for that. It is untracked first, which is what tells
   * its exit handler the exit is not a crash; resolving on the exit itself means that
   * handler — PID file included — has run by the time this returns.
   */
  private async terminate(platform: string, child: ChildProcess, graceMs: number): Promise<void> {
    if (this.bridges.get(platform)?.child === child) this.bridges.delete(platform);
    const exited =
      child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve(true)
        : new Promise<boolean>((res) => child.once("exit", () => res(true)));
    const within = async (ms: number) => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<boolean>((res) => {
        timer = setTimeout(() => res(false), ms);
      });
      try {
        return await Promise.race([exited, timeout]);
      } finally {
        clearTimeout(timer);
      }
    };
    const signal = (sig: NodeJS.Signals): NodeJS.ErrnoException | undefined => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
        return undefined;
      } catch (err) {
        return err as NodeJS.ErrnoException;
      }
    };

    const termErr = signal("SIGTERM");
    if (termErr) {
      // Never follow with a SIGKILL for a group we couldn't signal: it may be gone and
      // its pgid reused by the time the grace runs out.
      if (termErr.code !== "ESRCH") {
        blog.warn(`failed to stop bridge ${platform}`, log.errorData(termErr));
      }
      await within(this.killWaitMs);
      return;
    }
    if (await within(graceMs)) return;
    signal("SIGKILL");
    if (!(await within(this.killWaitMs))) {
      blog.warn(`bridge ${platform} (pid ${child.pid}) did not exit after SIGKILL`);
    }
  }

  /** Arm a crash restart, replacing any already pending for this platform. */
  private scheduleRestart(platform: string, daemonPort: number, delay: number): void {
    this.cancelPendingRestart(platform);
    const timer = setTimeout(() => {
      // Only the live timer may act — a cancelled or superseded one is stale.
      if (this.pendingRestarts.get(platform) !== timer) return;
      this.pendingRestarts.delete(platform);
      if (this.shuttingDown) return;
      this.startBridge(platform, daemonPort).catch((err) => {
        blog.error(`failed to restart bridge ${platform}`, log.errorData(err));
      });
    }, delay);
    this.pendingRestarts.set(platform, timer);
  }

  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    for (const platform of [...this.pendingRestarts.keys()]) this.cancelPendingRestart(platform);
    // Every platform with a child still alive — one a replacing start is terminating
    // included. (A start that hasn't run yet sees shuttingDown and refuses.)
    const platforms = new Set([...this.bridges.keys(), ...this.live.values()]);
    await Promise.all([...platforms].map((p) => this.stopBridge(p)));
  }

  getBridgeStatus(): { platform: string; running: boolean }[] {
    return [...this.bridges.entries()].map(([platform, tracked]) => ({
      platform,
      running: !tracked.child.killed,
    }));
  }

  isRunning(platform: string): boolean {
    const tracked = this.bridges.get(platform);
    return tracked != null && !tracked.child.killed;
  }

  /** Whether `pid` is a child of ours that hasn't exited yet. */
  private ownsPid(pid: number | null): boolean {
    return pid != null && [...this.live.keys()].some((c) => c.pid === pid);
  }

  private cancelPendingRestart(platform: string): boolean {
    const timer = this.pendingRestarts.get(platform);
    if (!timer) return false;
    clearTimeout(timer);
    this.pendingRestarts.delete(platform);
    return true;
  }

  private bridgePidPath(platform: string): string {
    return resolveWithinBase(resolve(voluteSystemDir(), "bridges"), `${platform}.pid`);
  }

  /**
   * Only a known platform may be started or stopped: its name becomes a PID file path
   * that is read, signalled and removed with daemon (root) privileges. An instance seam,
   * so tests can run fixture platforms.
   */
  private knownPlatform(platform: string): boolean {
    return getBridgeDef(platform) !== null;
  }

  /** Instance seam over {@link processIdentity}, so tests can stand in for the OS. */
  private processIdentity(pid: number): Promise<ProcessIdentity | null> {
    return processIdentity(pid);
  }

  private writeBridgePid(platform: string, record: BridgePidRecord): void {
    const pidPath = this.bridgePidPath(platform);
    mkdirSync(dirname(pidPath), { recursive: true });
    writeFileSync(pidPath, JSON.stringify(record));
  }

  /**
   * Add `child`'s start time and boot to its PID file. Skipped if it has already
   * exited: its exit handler has run, and nothing would remove the file.
   */
  private async saveBridgeIdentity(platform: string, child: ChildProcess): Promise<void> {
    const id = await this.processIdentity(child.pid!);
    if (!id || !this.live.has(child)) return;
    this.writeBridgePid(platform, { pid: child.pid!, start: id.start, boot: id.boot });
  }

  private readBridgePid(platform: string): BridgePidRecord | null {
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    try {
      const text = readFileSync(this.bridgePidPath(platform), "utf-8").trim();
      if (!text.startsWith("{")) return { pid: parseInt(text, 10), start: null, boot: null };
      const { pid, start, boot } = JSON.parse(text);
      return { pid: Number(pid), start: str(start), boot: str(boot) };
    } catch {
      return null;
    }
  }

  /**
   * Whether the process `id` describes is this platform's bridge: its command line runs
   * our bridge script, and the start time and boot, where recorded, are the ones it had.
   */
  private isOurBridge(platform: string, record: BridgePidRecord, id: ProcessIdentity): boolean {
    const script = this.resolveBuiltinBridge(platform);
    if (!script || (id.args !== script && !id.args.endsWith(` ${script}`))) return false;
    if (record.start !== null && record.start !== id.start) return false;
    return record.boot === null || record.boot === id.boot;
  }

  private removeBridgePid(platform: string): void {
    try {
      unlinkSync(this.bridgePidPath(platform));
    } catch (err: unknown) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code !== "ENOENT") {
        blog.warn(`failed to remove PID file for bridge ${platform}`, log.errorData(err));
      }
    }
  }

  /**
   * Signal a bridge an earlier daemon left running, if the PID file still names it. The
   * daemon is root on system installs, and a pid freed by a crash can be reused by any
   * process, so it's signalled only if it is still our bridge (`isOurBridge`); otherwise
   * the file is removed and nothing is signalled (#1360). A leader already gone isn't
   * signalled at all, so neither is anything left in its group.
   */
  private async killOrphanBridge(platform: string): Promise<void> {
    const pidPath = this.bridgePidPath(platform);
    if (!existsSync(pidPath)) return;
    try {
      const record = this.readBridgePid(platform);
      const pid = record?.pid ?? Number.NaN;
      // A child we replaced that is still in its kill grace is ours, not an orphan; its
      // exit handler cleans up after it.
      if (this.ownsPid(pid)) return;
      // Never 1: `kill(-1)` signals every process we're allowed to. No identity means
      // the process is gone: nothing to signal, as with ESRCH below.
      const id = pid > 1 ? await this.processIdentity(pid) : null;
      if (id && !this.isOurBridge(platform, record!, id)) {
        blog.warn(
          `not signalling pid ${pid} from bridge ${platform}'s PID file: it can't be confirmed as that bridge`,
        );
      } else if (id) {
        // Only ESRCH means it's gone; anything else (EPERM) means it may still be up.
        let failure: NodeJS.ErrnoException | undefined;
        for (const target of [-pid, pid]) {
          try {
            process.kill(target, "SIGTERM");
            failure = undefined;
            blog.warn(`killed orphan bridge ${platform} (pid ${pid})`);
            break;
          } catch (err) {
            failure = err as NodeJS.ErrnoException;
            if (failure.code !== "ESRCH") break;
          }
        }
        if (failure && failure.code !== "ESRCH") {
          blog.warn(
            `could not kill orphan bridge ${platform} (pid ${pid}) — it may still be running`,
            log.errorData(failure),
          );
          return; // keep its PID file: the only handle a later attempt has on it
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code !== "ESRCH") {
        blog.debug(`orphan bridge ${platform} cleanup: ${err}`);
      }
    }
    try {
      unlinkSync(pidPath);
    } catch (err: unknown) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code !== "ENOENT") {
        blog.warn(`failed to clean up PID file for orphan bridge ${platform}`, log.errorData(err));
      }
    }
  }

  /** Instance seam over {@link resolveBuiltinBridge}, so tests can point a manager at a fixture. */
  private resolveBuiltinBridge(platform: string): string | null {
    return resolveBuiltinBridge(platform);
  }
}

let instance: BridgeManager | null = null;

export function initBridgeManager(): BridgeManager {
  if (instance) throw new Error("BridgeManager already initialized");
  instance = new BridgeManager();
  return instance;
}

export function getBridgeManager(): BridgeManager {
  if (!instance) throw new ManagerNotReadyError("BridgeManager", "initBridgeManager");
  return instance;
}
