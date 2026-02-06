import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

type TrackedConnector = {
  child: ChildProcess;
  type: string;
};

export class ConnectorManager {
  private connectors = new Map<string, Map<string, TrackedConnector>>();
  private stopping = new Set<string>(); // "agent:type" keys currently being explicitly stopped
  private shuttingDown = false;

  async startConnectors(agentName: string, agentDir: string, agentPort: number): Promise<void> {
    const connectorsDir = resolve(agentDir, ".volute", "connectors");
    if (!existsSync(connectorsDir)) return;

    const entries = readdirSync(connectorsDir);
    for (const type of entries) {
      const typeDir = resolve(connectorsDir, type);
      if (!statSync(typeDir).isDirectory()) continue;

      const configPath = resolve(typeDir, "config.json");
      if (!existsSync(configPath)) continue;

      try {
        await this.startConnector(agentName, agentDir, agentPort, type);
      } catch (err) {
        console.error(`[daemon] failed to start connector ${type} for ${agentName}:`, err);
      }
    }
  }

  async startConnector(
    agentName: string,
    agentDir: string,
    agentPort: number,
    type: string,
  ): Promise<void> {
    // Stop existing connector of this type if running
    const existing = this.connectors.get(agentName)?.get(type);
    if (existing) {
      try {
        existing.child.kill("SIGTERM");
      } catch {}
    }

    const configPath = resolve(agentDir, ".volute", "connectors", type, "config.json");
    if (!existsSync(configPath)) {
      throw new Error(`No config.json found for connector ${type} on agent ${agentName}`);
    }

    // Resolve connector code: agent-specific > user-shared > built-in
    const agentConnector = resolve(agentDir, ".volute", "connectors", type, "index.ts");
    const userConnector = resolve(homedir(), ".volute", "connectors", type, "index.ts");
    const builtinConnector = this.resolveBuiltinConnector(type);

    let connectorScript: string;
    let tsxBin: string;

    if (existsSync(agentConnector)) {
      connectorScript = agentConnector;
      tsxBin = resolve(agentDir, "node_modules", ".bin", "tsx");
    } else if (existsSync(userConnector)) {
      connectorScript = userConnector;
      tsxBin = this.resolveVoluteTsx();
    } else if (builtinConnector && existsSync(builtinConnector)) {
      connectorScript = builtinConnector;
      tsxBin = this.resolveVoluteTsx();
    } else {
      throw new Error(`No connector code found for type: ${type}`);
    }

    // Set up log file
    const logsDir = resolve(agentDir, ".volute", "logs");
    mkdirSync(logsDir, { recursive: true });
    const logStream = createWriteStream(resolve(logsDir, `${type}.log`), { flags: "a" });

    const child = spawn(tsxBin, [connectorScript], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        VOLUTE_AGENT_PORT: String(agentPort),
        VOLUTE_AGENT_NAME: agentName,
        VOLUTE_CONNECTOR_CONFIG: configPath,
      },
    });

    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);

    if (!this.connectors.has(agentName)) {
      this.connectors.set(agentName, new Map());
    }
    this.connectors.get(agentName)!.set(type, { child, type });

    const stopKey = `${agentName}:${type}`;

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
      console.error(`[daemon] restarting connector ${type} for ${agentName} in 3s`);
      setTimeout(() => {
        if (this.shuttingDown || this.stopping.has(stopKey)) return;
        this.startConnector(agentName, agentDir, agentPort, type).catch((err) => {
          console.error(`[daemon] failed to restart connector ${type} for ${agentName}:`, err);
        });
      }, 3000);
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

  private resolveBuiltinConnector(type: string): string | null {
    // Search up from this module's location for connectors/<type>/index.ts
    let searchDir = dirname(new URL(import.meta.url).pathname);
    for (let i = 0; i < 5; i++) {
      const candidate = resolve(searchDir, "connectors", type, "index.ts");
      if (existsSync(candidate)) return candidate;
      searchDir = dirname(searchDir);
    }
    return null;
  }

  private resolveVoluteTsx(): string {
    // Find tsx from Volute's own node_modules
    let searchDir = dirname(new URL(import.meta.url).pathname);
    for (let i = 0; i < 5; i++) {
      const candidate = resolve(searchDir, "node_modules", ".bin", "tsx");
      if (existsSync(candidate)) return candidate;
      searchDir = dirname(searchDir);
    }
    // Fallback to just "tsx" on PATH
    return "tsx";
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
