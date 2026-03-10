import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { checkMissingBridgeEnv, getBridgeDef } from "../bridge-defs.js";
import { readBridgesConfig } from "../bridges.js";
import { readEnv, sharedEnvPath } from "../env.js";
import log from "../logger.js";
import { daemonLoopback, voluteSystemDir } from "../registry.js";
import { RotatingLog } from "../rotating-log.js";
import { RestartTracker } from "./restart-tracker.js";

const blog = log.child("bridges");

function searchUpwards(...segments: string[]): string | null {
  let searchDir = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(searchDir, ...segments);
    if (existsSync(candidate)) return candidate;
    searchDir = dirname(searchDir);
  }
  return null;
}

type TrackedBridge = {
  child: ChildProcess;
  platform: string;
};

export class BridgeManager {
  private bridges = new Map<string, TrackedBridge>();
  private stopping = new Set<string>();
  private shuttingDown = false;
  private restartTracker = new RestartTracker();

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

  async startBridge(platform: string, daemonPort: number): Promise<void> {
    // Stop existing bridge if running
    const existing = this.bridges.get(platform);
    if (existing) {
      await new Promise<void>((res) => {
        existing.child.on("exit", () => res());
        try {
          if (existing.child.pid) {
            process.kill(-existing.child.pid, "SIGTERM");
          } else {
            existing.child.kill("SIGTERM");
          }
        } catch {
          res();
        }
        setTimeout(() => {
          try {
            if (existing.child.pid) {
              process.kill(-existing.child.pid, "SIGKILL");
            } else {
              existing.child.kill("SIGKILL");
            }
          } catch {}
          res();
        }, 3000);
      });
      this.bridges.delete(platform);
    }

    // Kill orphan from previous daemon session
    this.killOrphanBridge(platform);

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

    let lastStderr = "";
    child.stdout?.pipe(logStream);
    child.stderr?.on("data", (chunk: Buffer) => {
      logStream.write(chunk);
      lastStderr = chunk.toString().trim();
    });

    if (child.pid) {
      this.saveBridgePid(platform, child.pid);
    }

    this.bridges.set(platform, { child, platform });
    this.restartTracker.reset(platform);

    // Crash recovery
    child.on("exit", (code) => {
      const tracked = this.bridges.get(platform);
      if (tracked?.child === child) {
        this.bridges.delete(platform);
      }

      if (this.shuttingDown) return;
      if (this.stopping.has(platform)) return;

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
      setTimeout(() => {
        if (this.shuttingDown || this.stopping.has(platform)) return;
        this.startBridge(platform, daemonPort).catch((err) => {
          blog.error(`failed to restart bridge ${platform}`, log.errorData(err));
        });
      }, delay);
    });

    blog.info(`started bridge ${platform}`);
  }

  async stopBridge(platform: string): Promise<void> {
    const tracked = this.bridges.get(platform);
    if (!tracked) return;

    this.stopping.add(platform);
    this.bridges.delete(platform);

    await new Promise<void>((resolve) => {
      tracked.child.on("exit", () => resolve());
      try {
        if (tracked.child.pid) {
          process.kill(-tracked.child.pid, "SIGTERM");
        } else {
          tracked.child.kill("SIGTERM");
        }
      } catch {
        resolve();
      }
      setTimeout(() => {
        try {
          if (tracked.child.pid) {
            process.kill(-tracked.child.pid, "SIGKILL");
          } else {
            tracked.child.kill("SIGKILL");
          }
        } catch {}
        resolve();
      }, 5000);
    });

    this.stopping.delete(platform);
    this.restartTracker.reset(platform);
    try {
      this.removeBridgePid(platform);
    } catch (err) {
      blog.warn(`failed to remove PID file for bridge ${platform}`, log.errorData(err));
    }
    blog.info(`stopped bridge ${platform}`);
  }

  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    const platforms = [...this.bridges.keys()];
    await Promise.all(platforms.map((p) => this.stopBridge(p)));
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

  private bridgePidPath(platform: string): string {
    return resolve(voluteSystemDir(), "bridges", `${platform}.pid`);
  }

  private saveBridgePid(platform: string, pid: number): void {
    const pidPath = this.bridgePidPath(platform);
    mkdirSync(dirname(pidPath), { recursive: true });
    writeFileSync(pidPath, String(pid));
  }

  private removeBridgePid(platform: string): void {
    try {
      unlinkSync(this.bridgePidPath(platform));
    } catch {
      // PID file may not exist
    }
  }

  private killOrphanBridge(platform: string): void {
    const pidPath = this.bridgePidPath(platform);
    if (!existsSync(pidPath)) return;
    try {
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      if (pid > 0) {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          process.kill(pid, "SIGTERM");
        }
        blog.warn(`killed orphan bridge ${platform} (pid ${pid})`);
      }
    } catch {
      // Process may not exist
    }
    try {
      unlinkSync(pidPath);
    } catch {
      // Best-effort cleanup
    }
  }

  private resolveBuiltinBridge(platform: string): string | null {
    return searchUpwards("connectors", `${platform}-bridge.js`);
  }
}

let instance: BridgeManager | null = null;

export function initBridgeManager(): BridgeManager {
  if (instance) throw new Error("BridgeManager already initialized");
  instance = new BridgeManager();
  return instance;
}

export function getBridgeManager(): BridgeManager {
  if (!instance) throw new Error("BridgeManager not initialized — call initBridgeManager() first");
  return instance;
}
