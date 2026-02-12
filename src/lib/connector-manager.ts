import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { checkMissingEnvVars, getConnectorDef } from "./connector-defs.js";
import { loadMergedEnv } from "./env.js";
import { applyIsolation } from "./isolation.js";
import { daemonLoopback, agentDir as getAgentDir, voluteHome } from "./registry.js";
import { RotatingLog } from "./rotating-log.js";
import { readVoluteConfig } from "./volute-config.js";

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
  private stopping = new Set<string>(); // "agent:type" keys currently being explicitly stopped
  private shuttingDown = false;
  private restartAttempts = new Map<string, number>(); // "agent:type" -> count

  async startConnectors(
    agentName: string,
    agentDir: string,
    agentPort: number,
    daemonPort?: number,
  ): Promise<void> {
    const config = readVoluteConfig(agentDir) ?? {};
    const types = config.connectors ?? [];

    for (const type of types) {
      try {
        await this.startConnector(agentName, agentDir, agentPort, type, daemonPort);
      } catch (err) {
        console.error(`[daemon] failed to start connector ${type} for ${agentName}:`, err);
      }
    }
  }

  checkConnectorEnv(
    type: string,
    agentDir: string,
  ): { missing: { name: string; description: string }[]; connectorName: string } | null {
    // Check agent-specific, then user-shared connector dirs for custom connector.json
    const agentConnectorDir = resolve(agentDir, "connectors", type);
    const userConnectorDir = resolve(voluteHome(), "connectors", type);
    const connectorDir = existsSync(agentConnectorDir)
      ? agentConnectorDir
      : existsSync(userConnectorDir)
        ? userConnectorDir
        : undefined;
    const def = getConnectorDef(type, connectorDir);
    if (!def) return null;

    const env = loadMergedEnv(agentDir);
    const missing = checkMissingEnvVars(def, env);
    if (missing.length === 0) return null;

    return {
      missing: missing.map((v) => ({ name: v.name, description: v.description })),
      connectorName: def.displayName,
    };
  }

  async startConnector(
    agentName: string,
    agentDir: string,
    agentPort: number,
    type: string,
    daemonPort?: number,
  ): Promise<void> {
    // Stop existing connector of this type if running (wait for exit)
    const existing = this.connectors.get(agentName)?.get(type);
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
      this.connectors.get(agentName)?.delete(type);
    }

    // Kill orphan connector from a previous daemon session
    this.killOrphanConnector(agentDir, type);

    // Resolve connector code: agent-specific > user-shared > built-in
    const agentConnector = resolve(agentDir, "connectors", type, "index.ts");
    const userConnector = resolve(voluteHome(), "connectors", type, "index.ts");
    const builtinConnector = this.resolveBuiltinConnector(type);

    let connectorScript: string;
    let runtime: string;

    if (existsSync(agentConnector)) {
      connectorScript = agentConnector;
      runtime = resolve(agentDir, "node_modules", ".bin", "tsx");
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
    const logsDir = resolve(agentDir, ".volute", "logs");
    mkdirSync(logsDir, { recursive: true });
    const logStream = new RotatingLog(resolve(logsDir, `${type}.log`));

    // Pass connector-specific env vars from agent env
    const agentEnv = loadMergedEnv(agentDir);
    const prefix = `${type.toUpperCase()}_`;
    const connectorEnv = Object.fromEntries(
      Object.entries(agentEnv).filter(([k]) => k.startsWith(prefix)),
    );

    const spawnOpts: SpawnOptions = {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        VOLUTE_AGENT_PORT: String(agentPort),
        VOLUTE_AGENT_NAME: agentName,
        VOLUTE_AGENT_DIR: agentDir,
        ...(daemonPort
          ? {
              VOLUTE_DAEMON_URL: `http://${daemonLoopback()}:${daemonPort}`,
              VOLUTE_DAEMON_TOKEN: process.env.VOLUTE_DAEMON_TOKEN,
            }
          : {}),
        ...connectorEnv,
      },
    };

    await applyIsolation(spawnOpts, agentName);

    const child = spawn(runtime, [connectorScript], spawnOpts);

    let lastStderr = "";

    child.stdout?.pipe(logStream);
    child.stderr?.on("data", (chunk: Buffer) => {
      logStream.write(chunk);
      lastStderr = chunk.toString().trim();
    });

    // Track PID so orphans can be killed on next daemon startup
    if (child.pid) {
      this.saveConnectorPid(agentDir, type, child.pid);
    }

    if (!this.connectors.has(agentName)) {
      this.connectors.set(agentName, new Map());
    }
    this.connectors.get(agentName)!.set(type, { child, type });

    const stopKey = `${agentName}:${type}`;
    this.restartAttempts.delete(stopKey);

    // Crash recovery
    child.on("exit", (code) => {
      const agentMap = this.connectors.get(agentName);
      if (agentMap?.get(type)?.child === child) {
        agentMap.delete(type);
      }

      if (this.shuttingDown) return;

      // If explicitly stopped, don't restart
      if (this.stopping.has(stopKey)) return;

      console.error(`[daemon] connector ${type} for ${agentName} exited with code ${code}`);
      if (lastStderr) console.error(`[daemon] last output: ${lastStderr}`);
      const attempts = this.restartAttempts.get(stopKey) ?? 0;
      if (attempts >= MAX_RESTART_ATTEMPTS) {
        console.error(
          `[daemon] connector ${type} for ${agentName} crashed ${attempts} times — giving up`,
        );
        return;
      }
      const delay = Math.min(BASE_RESTART_DELAY * 2 ** attempts, MAX_RESTART_DELAY);
      this.restartAttempts.set(stopKey, attempts + 1);
      console.error(
        `[daemon] restarting connector ${type} for ${agentName} — attempt ${attempts + 1}/${MAX_RESTART_ATTEMPTS}, in ${delay}ms`,
      );
      setTimeout(() => {
        if (this.shuttingDown || this.stopping.has(stopKey)) return;
        this.startConnector(agentName, agentDir, agentPort, type, daemonPort).catch((err) => {
          console.error(`[daemon] failed to restart connector ${type} for ${agentName}:`, err);
        });
      }, delay);
    });

    console.error(`[daemon] started connector ${type} for ${agentName}`);
  }

  async stopConnector(agentName: string, type: string): Promise<void> {
    const agentMap = this.connectors.get(agentName);
    if (!agentMap) return;

    const tracked = agentMap.get(type);
    if (!tracked) return;

    const stopKey = `${agentName}:${type}`;
    this.stopping.add(stopKey);
    agentMap.delete(type);

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
      this.removeConnectorPid(getAgentDir(agentName), type);
    } catch {}
    console.error(`[daemon] stopped connector ${type} for ${agentName}`);
  }

  async stopConnectors(agentName: string): Promise<void> {
    const agentMap = this.connectors.get(agentName);
    if (!agentMap) return;

    const types = [...agentMap.keys()];
    await Promise.all(types.map((type) => this.stopConnector(agentName, type)));
    this.connectors.delete(agentName);
  }

  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    const agents = [...this.connectors.keys()];
    await Promise.all(agents.map((name) => this.stopConnectors(name)));
  }

  getConnectorStatus(agentName: string): { type: string; running: boolean }[] {
    const agentMap = this.connectors.get(agentName);
    if (!agentMap) return [];
    return [...agentMap.entries()].map(([type, tracked]) => ({
      type,
      running: !tracked.child.killed,
    }));
  }

  private connectorPidPath(agentDir: string, type: string): string {
    return resolve(agentDir, ".volute", "connectors", `${type}.pid`);
  }

  private saveConnectorPid(agentDir: string, type: string, pid: number): void {
    const pidPath = this.connectorPidPath(agentDir, type);
    mkdirSync(dirname(pidPath), { recursive: true });
    writeFileSync(pidPath, String(pid));
  }

  private removeConnectorPid(agentDir: string, type: string): void {
    try {
      unlinkSync(this.connectorPidPath(agentDir, type));
    } catch {
      // PID file may not exist — ignore
    }
  }

  private killOrphanConnector(agentDir: string, type: string): void {
    const pidPath = this.connectorPidPath(agentDir, type);
    if (!existsSync(pidPath)) return;
    try {
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      if (pid > 0) {
        process.kill(pid, "SIGTERM");
        console.error(`[daemon] killed orphan connector ${type} (pid ${pid})`);
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
