import { type ChildProcess, execFile, type SpawnOptions, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { loadMergedEnv } from "./env.js";
import { applyIsolation } from "./isolation.js";
import { clearJsonMap, loadJsonMap, saveJsonMap } from "./json-state.js";
import { agentDir, findAgent, setAgentRunning, voluteHome } from "./registry.js";
import { findVariant, setVariantRunning, validateBranchName } from "./variants.js";

const execFileAsync = promisify(execFile);

type TrackedAgent = {
  child: ChildProcess;
  port: number;
};

const MAX_RESTART_ATTEMPTS = 5;
const BASE_RESTART_DELAY = 3000;
const MAX_RESTART_DELAY = 60000;

export class AgentManager {
  private agents = new Map<string, TrackedAgent>();
  private stopping = new Set<string>();
  private shuttingDown = false;
  private restartAttempts = new Map<string, number>();

  private resolveTarget(name: string): {
    dir: string;
    port: number;
    isVariant: boolean;
    baseName: string;
    variantName?: string;
  } {
    const [baseName, variantName] = name.split("@", 2);

    const entry = findAgent(baseName);
    if (!entry) throw new Error(`Unknown agent: ${baseName}`);

    if (variantName) {
      const variant = findVariant(baseName, variantName);
      if (!variant) throw new Error(`Unknown variant: ${variantName} (agent: ${baseName})`);
      return { dir: variant.path, port: variant.port, isVariant: true, baseName, variantName };
    }

    const dir = agentDir(baseName);
    if (!existsSync(dir)) throw new Error(`Agent directory missing: ${dir}`);
    return { dir, port: entry.port, isVariant: false, baseName };
  }

  async startAgent(name: string): Promise<void> {
    if (this.agents.has(name)) {
      throw new Error(`Agent ${name} is already running`);
    }

    const target = this.resolveTarget(name);
    const { dir, isVariant, baseName, variantName } = target;
    const port = target.port;

    // Kill any orphan process on this port from a previous daemon session
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) {
        console.error(`[daemon] killing orphan process on port ${port}`);
        await killProcessOnPort(port);
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch {
      // Port not in use — good
    }

    const voluteDir = resolve(dir, ".volute");
    const logsDir = resolve(voluteDir, "logs");
    mkdirSync(logsDir, { recursive: true });

    const logStream = createWriteStream(resolve(logsDir, "agent.log"), {
      flags: "a",
    });
    const agentEnv = loadMergedEnv(dir);
    const { VOLUTE_DAEMON_TOKEN: _, ...parentEnv } = process.env;
    const env = { ...parentEnv, ...agentEnv, VOLUTE_AGENT: name };
    const tsxBin = resolve(dir, "node_modules", ".bin", "tsx");

    const spawnOpts: SpawnOptions = {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env,
    };

    await applyIsolation(spawnOpts, name);

    const child = spawn(tsxBin, ["src/server.ts", "--port", String(port)], spawnOpts);

    this.agents.set(name, { child, port });

    // Pipe output to log file and check for listening
    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);

    // Wait for "listening on :PORT" or timeout
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Agent ${name} did not start within 30s`));
        }, 30000);

        function checkOutput(data: Buffer) {
          if (data.toString().match(/listening on :\d+/)) {
            clearTimeout(timeout);
            resolve();
          }
        }

        child.stdout?.on("data", checkOutput);
        child.stderr?.on("data", checkOutput);

        child.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });

        child.on("exit", (code) => {
          clearTimeout(timeout);
          reject(new Error(`Agent ${name} exited with code ${code} during startup`));
        });
      });
    } catch (err) {
      this.agents.delete(name);
      try {
        child.kill();
      } catch {}
      throw err;
    }

    // Set up crash recovery after successful start
    if (this.restartAttempts.delete(name)) this.saveCrashAttempts();
    this.setupCrashRecovery(name, child, dir, isVariant);
    if (isVariant) {
      setVariantRunning(baseName, variantName!, true);
    } else {
      setAgentRunning(name, true);
    }

    console.error(`[daemon] started agent ${name} on port ${port}`);
  }

  private setupCrashRecovery(
    name: string,
    child: ChildProcess,
    dir: string,
    isVariant: boolean,
  ): void {
    child.on("exit", async (code) => {
      this.agents.delete(name);
      if (this.shuttingDown || this.stopping.has(name)) return;

      console.error(`[daemon] agent ${name} exited with code ${code}`);

      // Variants don't support merge-restart
      const wasRestart = isVariant ? false : await this.handleRestart(name, dir);
      if (wasRestart) {
        console.error(`[daemon] restarting ${name} immediately after merge`);
        if (this.restartAttempts.delete(name)) this.saveCrashAttempts();
        this.startAgent(name).catch((err) => {
          console.error(`[daemon] failed to restart ${name} after merge:`, err);
        });
      } else {
        const attempts = this.restartAttempts.get(name) ?? 0;
        if (attempts >= MAX_RESTART_ATTEMPTS) {
          console.error(`[daemon] ${name} crashed ${attempts} times — giving up on restart`);
          const [base, variant] = name.split("@", 2);
          if (variant) {
            setVariantRunning(base, variant, false);
          } else {
            setAgentRunning(name, false);
          }
          return;
        }
        const delay = Math.min(BASE_RESTART_DELAY * 2 ** attempts, MAX_RESTART_DELAY);
        this.restartAttempts.set(name, attempts + 1);
        this.saveCrashAttempts();
        console.error(
          `[daemon] crash recovery for ${name} — attempt ${attempts + 1}/${MAX_RESTART_ATTEMPTS}, restarting in ${delay}ms`,
        );
        setTimeout(() => {
          if (this.shuttingDown) return;
          this.startAgent(name).catch((err) => {
            console.error(`[daemon] failed to restart ${name}:`, err);
          });
        }, delay);
      }
    });
  }

  private async handleRestart(name: string, dir: string): Promise<boolean> {
    const restartPath = resolve(dir, ".volute", "restart.json");
    if (!existsSync(restartPath)) return false;

    try {
      const signal = JSON.parse(readFileSync(restartPath, "utf-8"));
      unlinkSync(restartPath);

      if (signal.action === "merge" && signal.name) {
        const err = validateBranchName(signal.name);
        if (err) {
          console.error(`[daemon] invalid variant name in restart.json for ${name}: ${err}`);
          return false;
        }
        console.error(`[daemon] merging variant for ${name}: ${signal.name}`);
        const mergeArgs = ["merge", name, signal.name];
        if (signal.summary) mergeArgs.push("--summary", signal.summary);
        if (signal.justification) mergeArgs.push("--justification", signal.justification);
        if (signal.memory) mergeArgs.push("--memory", signal.memory);
        const { VOLUTE_DAEMON_TOKEN: _t, ...mergeEnv } = process.env;
        await execFileAsync("volute", mergeArgs, {
          cwd: dir,
          env: { ...mergeEnv, VOLUTE_SUPERVISOR: "1" },
        });
      }

      return true;
    } catch (e) {
      console.error(`[daemon] failed to handle restart for ${name}:`, e);
      return false;
    }
  }

  async stopAgent(name: string): Promise<void> {
    const tracked = this.agents.get(name);
    if (!tracked) return;

    this.stopping.add(name);
    const { child } = tracked;
    this.agents.delete(name);

    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      try {
        // Kill the entire process group (tsx + node child)
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        resolve();
      }
      // Force kill after 5s
      setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {}
        resolve();
      }, 5000);
    });

    this.stopping.delete(name);
    if (this.restartAttempts.delete(name)) this.saveCrashAttempts();

    const [baseName, variantName] = name.split("@", 2);
    if (variantName) {
      setVariantRunning(baseName, variantName, false);
    } else {
      setAgentRunning(name, false);
    }

    console.error(`[daemon] stopped agent ${name}`);
  }

  async restartAgent(name: string): Promise<void> {
    await this.stopAgent(name);
    await this.startAgent(name);
  }

  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    const names = [...this.agents.keys()];
    await Promise.all(names.map((name) => this.stopAgent(name)));
  }

  isRunning(name: string): boolean {
    return this.agents.has(name);
  }

  getRunningAgents(): string[] {
    return [...this.agents.keys()];
  }

  private get crashAttemptsPath(): string {
    return resolve(voluteHome(), "crash-attempts.json");
  }

  loadCrashAttempts(): void {
    this.restartAttempts = loadJsonMap(this.crashAttemptsPath);
  }

  private saveCrashAttempts(): void {
    saveJsonMap(this.crashAttemptsPath, this.restartAttempts);
  }

  clearCrashAttempts(): void {
    clearJsonMap(this.crashAttemptsPath, this.restartAttempts);
  }
}

async function killProcessOnPort(port: number): Promise<void> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"]);
    const pids = new Set<number>();
    for (const line of stdout.trim().split("\n").filter(Boolean)) {
      const pid = parseInt(line, 10);
      pids.add(pid);
      // Find the process group to kill supervisors/wrappers too
      try {
        const { stdout: psOut } = await execFileAsync("ps", ["-p", String(pid), "-o", "pgid="]);
        const pgid = parseInt(psOut.trim(), 10);
        if (pgid > 1) pids.add(pgid);
      } catch {}
    }
    for (const pid of pids) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {}
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
  } catch {
    // lsof may fail if no process on port — expected
  }
}

let instance: AgentManager | null = null;

export function initAgentManager(): AgentManager {
  if (instance) throw new Error("AgentManager already initialized");
  instance = new AgentManager();
  return instance;
}

export function getAgentManager(): AgentManager {
  if (!instance) instance = new AgentManager();
  return instance;
}
