import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { checkMissingEnvVars, getConnectorDef } from "./connector-defs.js";
import { loadMergedEnv } from "./env.js";
import { chownMindDir, isIsolationEnabled, wrapForIsolation } from "./isolation.js";
import log from "./logger.js";
import { daemonLoopback, stateDir, voluteHome } from "./registry.js";
import { RotatingLog } from "./rotating-log.js";
import { readVoluteConfig } from "./volute-config.js";

const clog = log.child("connectors");

function searchUpwards(...segments: string[]): string | null {
  let searchDir = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(searchDir, ...segments);
    if (existsSync(candidate)) return candidate;
    searchDir = dirname(searchDir);
  }
  return null;
}

type TrackedConnector = {
  child: ChildProcess;
  type: string;
};

const MAX_RESTART_ATTEMPTS = 5;
const BASE_RESTART_DELAY = 3000;
const MAX_RESTART_DELAY = 60000;

export class ConnectorManager {
  private connectors = new Map<string, Map<string, TrackedConnector>>();
  private stopping = new Set<string>(); // "mind:type" keys currently being explicitly stopped
  private shuttingDown = false;
  private restartAttempts = new Map<string, number>(); // "mind:type" -> count

  async startConnectors(
    mindName: string,
    mindDir: string,
    mindPort: number,
    daemonPort?: number,
  ): Promise<void> {
    const config = readVoluteConfig(mindDir) ?? {};
    const types = config.connectors ?? [];

    for (const type of types) {
      try {
        await this.startConnector(mindName, mindDir, mindPort, type, daemonPort);
      } catch (err) {
        clog.warn(`failed to start connector ${type} for ${mindName}`, log.errorData(err));
      }
    }
  }

  checkConnectorEnv(
    type: string,
    mindName: string,
    mindDir: string,
  ): { missing: { name: string; description: string }[]; connectorName: string } | null {
    // Check mind-specific, then user-shared connector dirs for custom connector.json
    const mindConnectorDir = resolve(mindDir, "connectors", type);
    const userConnectorDir = resolve(voluteHome(), "connectors", type);
    const connectorDir = existsSync(mindConnectorDir)
      ? mindConnectorDir
      : existsSync(userConnectorDir)
        ? userConnectorDir
        : undefined;
    const def = getConnectorDef(type, connectorDir);
    if (!def) return null;

    const env = loadMergedEnv(mindName);
    const missing = checkMissingEnvVars(def, env);
    if (missing.length === 0) return null;

    return {
      missing: missing.map((v) => ({ name: v.name, description: v.description })),
      connectorName: def.displayName,
    };
  }

  async startConnector(
    mindName: string,
    mindDir: string,
    mindPort: number,
    type: string,
    daemonPort?: number,
  ): Promise<void> {
    // Stop existing connector of this type if running (wait for exit)
    const existing = this.connectors.get(mindName)?.get(type);
    if (existing) {
      await new Promise<void>((res) => {
        existing.child.on("exit", () => res());
        try {
          existing.child.kill("SIGTERM");
        } catch {
          res();
        }
        setTimeout(() => {
          try {
            existing.child.kill("SIGKILL");
          } catch {}
          res();
        }, 3000);
      });
      this.connectors.get(mindName)?.delete(type);
    }

    // Kill orphan connector from a previous daemon session
    this.killOrphanConnector(mindName, type);

    // Resolve connector code: mind-specific > user-shared > built-in
    const mindConnector = resolve(mindDir, "connectors", type, "index.ts");
    const userConnector = resolve(voluteHome(), "connectors", type, "index.ts");
    const builtinConnector = this.resolveBuiltinConnector(type);

    let connectorScript: string;
    let runtime: string;

    if (existsSync(mindConnector)) {
      connectorScript = mindConnector;
      runtime = resolve(mindDir, "node_modules", ".bin", "tsx");
    } else if (existsSync(userConnector)) {
      connectorScript = userConnector;
      runtime = this.resolveVoluteTsx();
    } else if (builtinConnector) {
      connectorScript = builtinConnector;
      runtime = process.execPath;
    } else {
      throw new Error(`No connector code found for type: ${type}`);
    }

    // Set up log file
    const mindStateDir = stateDir(mindName);
    const logsDir = resolve(mindStateDir, "logs");
    mkdirSync(logsDir, { recursive: true });

    // State dir is created by root — chown so the mind user can write channels.json, etc.
    if (isIsolationEnabled()) {
      try {
        const [base] = mindName.split("@", 2);
        chownMindDir(mindStateDir, base);
      } catch (err) {
        throw new Error(
          `Cannot start connector ${type} for ${mindName}: failed to set ownership on state directory ${mindStateDir}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    const logStream = new RotatingLog(resolve(logsDir, `${type}.log`));

    // Pass connector-specific env vars from mind env
    const mindEnv = loadMergedEnv(mindName);
    const prefix = `${type.toUpperCase()}_`;
    const connectorEnv = Object.fromEntries(
      Object.entries(mindEnv).filter(([k]) => k.startsWith(prefix)),
    );

    const spawnOpts: SpawnOptions = {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        VOLUTE_MIND_PORT: String(mindPort),
        VOLUTE_MIND_NAME: mindName,
        VOLUTE_MIND_DIR: mindDir,
        ...(daemonPort
          ? {
              VOLUTE_DAEMON_URL: `http://${daemonLoopback()}:${daemonPort}`,
              VOLUTE_DAEMON_TOKEN: process.env.VOLUTE_DAEMON_TOKEN,
            }
          : {}),
        ...connectorEnv,
      },
    };

    const [spawnCmd, spawnArgs] = wrapForIsolation(runtime, [connectorScript], mindName);

    const child = spawn(spawnCmd, spawnArgs, spawnOpts);

    let lastStderr = "";

    child.stdout?.pipe(logStream);
    child.stderr?.on("data", (chunk: Buffer) => {
      logStream.write(chunk);
      lastStderr = chunk.toString().trim();
    });

    // Track PID so orphans can be killed on next daemon startup
    if (child.pid) {
      this.saveConnectorPid(mindName, type, child.pid);
    }

    if (!this.connectors.has(mindName)) {
      this.connectors.set(mindName, new Map());
    }
    this.connectors.get(mindName)!.set(type, { child, type });

    const stopKey = `${mindName}:${type}`;
    this.restartAttempts.delete(stopKey);

    // Crash recovery
    child.on("exit", (code) => {
      const mindMap = this.connectors.get(mindName);
      if (mindMap?.get(type)?.child === child) {
        mindMap.delete(type);
      }

      if (this.shuttingDown) return;

      // If explicitly stopped, don't restart
      if (this.stopping.has(stopKey)) return;

      clog.error(`connector ${type} for ${mindName} exited with code ${code}`);
      if (lastStderr) clog.warn(`connector ${type} last output: ${lastStderr}`);
      const attempts = this.restartAttempts.get(stopKey) ?? 0;
      if (attempts >= MAX_RESTART_ATTEMPTS) {
        clog.error(`connector ${type} for ${mindName} crashed ${attempts} times — giving up`);
        return;
      }
      const delay = Math.min(BASE_RESTART_DELAY * 2 ** attempts, MAX_RESTART_DELAY);
      this.restartAttempts.set(stopKey, attempts + 1);
      clog.info(
        `restarting connector ${type} for ${mindName} — attempt ${attempts + 1}/${MAX_RESTART_ATTEMPTS}, in ${delay}ms`,
      );
      setTimeout(() => {
        if (this.shuttingDown || this.stopping.has(stopKey)) return;
        this.startConnector(mindName, mindDir, mindPort, type, daemonPort).catch((err) => {
          clog.error(`failed to restart connector ${type} for ${mindName}`, log.errorData(err));
        });
      }, delay);
    });

    clog.info(`started connector ${type} for ${mindName}`);
  }

  async stopConnector(mindName: string, type: string): Promise<void> {
    const mindMap = this.connectors.get(mindName);
    if (!mindMap) return;

    const tracked = mindMap.get(type);
    if (!tracked) return;

    const stopKey = `${mindName}:${type}`;
    this.stopping.add(stopKey);
    mindMap.delete(type);

    await new Promise<void>((resolve) => {
      tracked.child.on("exit", () => resolve());
      try {
        tracked.child.kill("SIGTERM");
      } catch {
        resolve();
      }
      setTimeout(() => {
        try {
          tracked.child.kill("SIGKILL");
        } catch {}
        resolve();
      }, 5000);
    });

    this.stopping.delete(stopKey);
    this.restartAttempts.delete(stopKey);
    try {
      this.removeConnectorPid(mindName, type);
    } catch (err) {
      clog.warn(`failed to remove PID file for ${type}/${mindName}`, log.errorData(err));
    }
    clog.info(`stopped connector ${type} for ${mindName}`);
  }

  async stopConnectors(mindName: string): Promise<void> {
    const mindMap = this.connectors.get(mindName);
    if (!mindMap) return;

    const types = [...mindMap.keys()];
    await Promise.all(types.map((type) => this.stopConnector(mindName, type)));
    this.connectors.delete(mindName);
  }

  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    const minds = [...this.connectors.keys()];
    await Promise.all(minds.map((name) => this.stopConnectors(name)));
  }

  getConnectorStatus(mindName: string): { type: string; running: boolean }[] {
    const mindMap = this.connectors.get(mindName);
    if (!mindMap) return [];
    return [...mindMap.entries()].map(([type, tracked]) => ({
      type,
      running: !tracked.child.killed,
    }));
  }

  private connectorPidPath(mindName: string, type: string): string {
    return resolve(stateDir(mindName), "connectors", `${type}.pid`);
  }

  private saveConnectorPid(mindName: string, type: string, pid: number): void {
    const pidPath = this.connectorPidPath(mindName, type);
    mkdirSync(dirname(pidPath), { recursive: true });
    writeFileSync(pidPath, String(pid));
  }

  private removeConnectorPid(mindName: string, type: string): void {
    try {
      unlinkSync(this.connectorPidPath(mindName, type));
    } catch {
      // PID file may not exist — ignore
    }
  }

  private killOrphanConnector(mindName: string, type: string): void {
    const pidPath = this.connectorPidPath(mindName, type);
    if (!existsSync(pidPath)) return;
    try {
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      if (pid > 0) {
        process.kill(pid, "SIGTERM");
        clog.warn(`killed orphan connector ${type} (pid ${pid})`);
      }
    } catch {
      // Process may not exist — ignore
    }
    try {
      unlinkSync(pidPath);
    } catch {
      // PID file cleanup is best-effort
    }
  }

  private resolveBuiltinConnector(type: string): string | null {
    return searchUpwards("connectors", `${type}.js`);
  }

  private resolveVoluteTsx(): string {
    return searchUpwards("node_modules", ".bin", "tsx") ?? "tsx";
  }
}

let instance: ConnectorManager | null = null;

export function initConnectorManager(): ConnectorManager {
  if (instance) throw new Error("ConnectorManager already initialized");
  instance = new ConnectorManager();
  return instance;
}

export function getConnectorManager(): ConnectorManager {
  if (!instance) instance = new ConnectorManager();
  return instance;
}
