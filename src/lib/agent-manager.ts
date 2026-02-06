import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { loadMergedEnv } from "./env.js";
import { agentDir, findAgent, setAgentRunning } from "./registry.js";

type TrackedAgent = {
  child: ChildProcess;
  port: number;
};

export class AgentManager {
  private agents = new Map<string, TrackedAgent>();
  private shuttingDown = false;

  async startAgent(name: string): Promise<void> {
    if (this.agents.has(name)) {
      throw new Error(`Agent ${name} is already running`);
    }

    const entry = findAgent(name);
    if (!entry) throw new Error(`Unknown agent: ${name}`);

    const dir = agentDir(name);
    if (!existsSync(dir)) throw new Error(`Agent directory missing: ${dir}`);

    const port = entry.port;
    const voluteDir = resolve(dir, ".volute");
    const logsDir = resolve(voluteDir, "logs");
    mkdirSync(logsDir, { recursive: true });

    const logStream = createWriteStream(resolve(logsDir, "agent.log"), {
      flags: "a",
    });
    const agentEnv = loadMergedEnv(dir);
    const env = { ...process.env, ...agentEnv, VOLUTE_AGENT: name };
    const tsxBin = resolve(dir, "node_modules", ".bin", "tsx");

    const child = spawn(tsxBin, ["src/server.ts", "--port", String(port)], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    this.agents.set(name, { child, port });

    // Pipe output to log file and check for listening
    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);

    // Wait for "listening on :PORT" or timeout
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

    // Set up crash recovery after successful start
    this.setupCrashRecovery(name, child, dir);
    setAgentRunning(name, true);

    console.error(`[daemon] started agent ${name} on port ${port}`);
  }

  private setupCrashRecovery(name: string, child: ChildProcess, dir: string): void {
    child.on("exit", (code) => {
      this.agents.delete(name);
      if (this.shuttingDown) return;

      console.error(`[daemon] agent ${name} exited with code ${code}`);

      const wasRestart = this.handleRestart(name, dir);
      if (wasRestart) {
        console.error(`[daemon] restarting ${name} immediately after merge`);
        this.startAgent(name).catch((err) => {
          console.error(`[daemon] failed to restart ${name} after merge:`, err);
        });
      } else {
        console.error(`[daemon] crash recovery for ${name} — restarting in 3s`);
        setTimeout(() => {
          if (this.shuttingDown) return;
          this.startAgent(name).catch((err) => {
            console.error(`[daemon] failed to restart ${name}:`, err);
          });
        }, 3000);
      }
    });
  }

  private handleRestart(name: string, dir: string): boolean {
    const restartPath = resolve(dir, ".volute", "restart.json");
    if (!existsSync(restartPath)) return false;

    try {
      const signal = JSON.parse(readFileSync(restartPath, "utf-8"));
      unlinkSync(restartPath);

      if (signal.action === "merge" && signal.name) {
        console.error(`[daemon] merging variant for ${name}: ${signal.name}`);
        try {
          const mergeArgs = ["merge", name, signal.name];
          if (signal.summary) mergeArgs.push("--summary", signal.summary);
          if (signal.justification) mergeArgs.push("--justification", signal.justification);
          if (signal.memory) mergeArgs.push("--memory", signal.memory);
          execFile("volute", mergeArgs, {
            cwd: dir,
            env: { ...process.env, VOLUTE_SUPERVISOR: "1" },
          });
        } catch (e) {
          console.error(`[daemon] volute merge failed for ${name}:`, e);
        }
      }

      return true;
    } catch (e) {
      console.error(`[daemon] failed to read restart signal for ${name}:`, e);
      return false;
    }
  }

  async stopAgent(name: string): Promise<void> {
    const tracked = this.agents.get(name);
    if (!tracked) return;

    const { child } = tracked;
    this.agents.delete(name);

    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      try {
        child.kill("SIGTERM");
      } catch {
        resolve();
      }
      // Force kill after 5s
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
        resolve();
      }, 5000);
    });

    setAgentRunning(name, false);
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
