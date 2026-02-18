import { type ChildProcess, execFile, type SpawnOptions, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { loadMergedEnv } from "./env.js";
import { chownMindDir, isIsolationEnabled, wrapForIsolation } from "./isolation.js";
import { clearJsonMap, loadJsonMap, saveJsonMap } from "./json-state.js";
import { findMind, mindDir, setMindRunning, stateDir, voluteHome } from "./registry.js";
import { RotatingLog } from "./rotating-log.js";
import { findVariant, setVariantRunning } from "./variants.js";

const execFileAsync = promisify(execFile);

type TrackedMind = {
  child: ChildProcess;
  port: number;
};

function mindPidPath(name: string): string {
  return resolve(stateDir(name), "mind.pid");
}

const MAX_RESTART_ATTEMPTS = 5;
const BASE_RESTART_DELAY = 3000;
const MAX_RESTART_DELAY = 60000;

export class MindManager {
  private minds = new Map<string, TrackedMind>();
  private stopping = new Set<string>();
  private shuttingDown = false;
  private restartAttempts = new Map<string, number>();
  private pendingContext = new Map<string, Record<string, unknown>>();

  private resolveTarget(name: string): {
    dir: string;
    port: number;
    isVariant: boolean;
    baseName: string;
    variantName?: string;
  } {
    const [baseName, variantName] = name.split("@", 2);

    const entry = findMind(baseName);
    if (!entry) throw new Error(`Unknown mind: ${baseName}`);

    if (variantName) {
      const variant = findVariant(baseName, variantName);
      if (!variant) throw new Error(`Unknown variant: ${variantName} (mind: ${baseName})`);
      return { dir: variant.path, port: variant.port, isVariant: true, baseName, variantName };
    }

    const dir = mindDir(baseName);
    if (!existsSync(dir)) throw new Error(`Mind directory missing: ${dir}`);
    return { dir, port: entry.port, isVariant: false, baseName };
  }

  async startMind(name: string): Promise<void> {
    if (this.minds.has(name)) {
      throw new Error(`Mind ${name} is already running`);
    }

    const target = this.resolveTarget(name);
    const { dir, isVariant, baseName, variantName } = target;
    const port = target.port;

    // Kill any orphan process from a previous daemon session
    const pidFile = mindPidPath(name);
    try {
      if (existsSync(pidFile)) {
        const stalePid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
        if (stalePid > 0) {
          try {
            process.kill(stalePid, 0); // check if alive
            // Verify this is actually a mind process before killing the group
            const { stdout } = await execFileAsync("ps", ["-p", String(stalePid), "-o", "args="]);
            if (stdout.includes("server.ts")) {
              console.error(`[daemon] killing stale mind process ${stalePid} for ${name}`);
              process.kill(-stalePid, "SIGTERM");
              await new Promise((r) => setTimeout(r, 500));
            } else {
              console.error(
                `[daemon] stale PID ${stalePid} for ${name} is not a mind process, skipping`,
              );
            }
          } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
              console.error(`[daemon] failed to check/kill stale process for ${name}:`, err);
            }
          }
        }
        rmSync(pidFile, { force: true });
      }
    } catch (err) {
      console.error(`[daemon] failed to read PID file for ${name}:`, err);
    }

    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        console.error(`[daemon] killing orphan process on port ${port}`);
        await killProcessOnPort(port);
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch {
      // Port not in use — good
    }

    const mindStateDir = stateDir(name);
    const logsDir = resolve(mindStateDir, "logs");
    mkdirSync(logsDir, { recursive: true });

    // State dir is created by root — chown so the mind user can write channels.json, etc.
    if (isIsolationEnabled()) {
      try {
        chownMindDir(mindStateDir, baseName);
      } catch (err) {
        throw new Error(
          `Cannot start mind ${name}: failed to set ownership on state directory ${mindStateDir}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    const logStream = new RotatingLog(resolve(logsDir, "mind.log"));
    const mindEnv = loadMergedEnv(name);
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...mindEnv,
      VOLUTE_MIND: name,
      VOLUTE_STATE_DIR: stateDir(name),
      VOLUTE_MIND_DIR: dir,
      VOLUTE_MIND_PORT: String(port),
      // Strip CLAUDECODE so the Agent SDK can spawn Claude Code subprocesses
      CLAUDECODE: undefined,
    };

    if (isIsolationEnabled()) {
      env.HOME = resolve(dir, "home");
    }

    const tsxBin = resolve(dir, "node_modules", ".bin", "tsx");
    const tsxArgs = ["src/server.ts", "--port", String(port)];
    const [spawnCmd, spawnArgs] = wrapForIsolation(tsxBin, tsxArgs, name);

    const spawnOpts: SpawnOptions = {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env,
    };

    const child = spawn(spawnCmd, spawnArgs, spawnOpts);

    this.minds.set(name, { child, port });

    // Pipe output to log file and check for listening
    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);

    // Wait for "listening on :PORT" or timeout
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Mind ${name} did not start within 30s`));
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
          reject(new Error(`Mind ${name} exited with code ${code} during startup`));
        });
      });
    } catch (err) {
      this.minds.delete(name);
      try {
        child.kill();
      } catch {}
      throw err;
    }

    // Save PID file for orphan detection on next daemon start
    if (child.pid) {
      try {
        writeFileSync(pidFile, String(child.pid));
      } catch (err) {
        console.error(`[daemon] failed to write PID file for ${name}:`, err);
      }
    }

    // Set up crash recovery after successful start
    if (this.restartAttempts.delete(name)) this.saveCrashAttempts();
    this.setupCrashRecovery(name, child);
    if (isVariant) {
      setVariantRunning(baseName, variantName!, true);
    } else {
      setMindRunning(name, true);
    }

    console.error(`[daemon] started mind ${name} on port ${port}`);

    // Deliver any pending context (e.g. merge info) to the mind via HTTP
    await this.deliverPendingContext(name);
  }

  setPendingContext(name: string, context: Record<string, unknown>): void {
    this.pendingContext.set(name, context);
  }

  private async deliverPendingContext(name: string): Promise<void> {
    const context = this.pendingContext.get(name);
    if (!context) return;

    const tracked = this.minds.get(name);
    if (!tracked) return;

    this.pendingContext.delete(name);

    const parts: string[] = [];
    if (context.type === "merge" || context.type === "merged") {
      parts.push(`[system] Variant "${context.name}" has been merged and you have been restarted.`);
    } else if (context.type === "sprouted") {
      parts.push(
        "[system] You've sprouted. You now have full capabilities — connectors, schedules, variants, and the complete volute CLI. Check your new skills for details.",
      );
    } else {
      parts.push("[system] You have been restarted.");
    }
    if (context.summary) parts.push(`Changes: ${context.summary}`);
    if (context.justification) parts.push(`Why: ${context.justification}`);
    if (context.memory) parts.push(`Context: ${context.memory}`);

    try {
      await fetch(`http://127.0.0.1:${tracked.port}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: [{ type: "text", text: parts.join("\n") }],
          channel: "system",
        }),
      });
    } catch (err) {
      console.error(`[daemon] failed to deliver pending context to ${name}:`, err);
    }
  }

  private setupCrashRecovery(name: string, child: ChildProcess): void {
    child.on("exit", async (code) => {
      this.minds.delete(name);
      if (this.shuttingDown || this.stopping.has(name)) return;

      console.error(`[daemon] mind ${name} exited with code ${code}`);

      const attempts = this.restartAttempts.get(name) ?? 0;
      if (attempts >= MAX_RESTART_ATTEMPTS) {
        console.error(`[daemon] ${name} crashed ${attempts} times — giving up on restart`);
        const [base, variant] = name.split("@", 2);
        if (variant) {
          setVariantRunning(base, variant, false);
        } else {
          setMindRunning(name, false);
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
        this.startMind(name).catch((err) => {
          console.error(`[daemon] failed to restart ${name}:`, err);
        });
      }, delay);
    });
  }

  async stopMind(name: string): Promise<void> {
    const tracked = this.minds.get(name);
    if (!tracked) return;

    this.stopping.add(name);
    const { child } = tracked;
    this.minds.delete(name);

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
    rmSync(mindPidPath(name), { force: true });

    if (!this.shuttingDown) {
      const [baseName, variantName] = name.split("@", 2);
      if (variantName) {
        setVariantRunning(baseName, variantName, false);
      } else {
        setMindRunning(name, false);
      }
    }

    console.error(`[daemon] stopped mind ${name}`);
  }

  async restartMind(name: string): Promise<void> {
    await this.stopMind(name);
    await this.startMind(name);
  }

  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    const names = [...this.minds.keys()];
    await Promise.all(names.map((name) => this.stopMind(name)));
  }

  isRunning(name: string): boolean {
    return this.minds.has(name);
  }

  getRunningMinds(): string[] {
    return [...this.minds.keys()];
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

let instance: MindManager | null = null;

export function initMindManager(): MindManager {
  if (instance) throw new Error("MindManager already initialized");
  instance = new MindManager();
  return instance;
}

export function getMindManager(): MindManager {
  if (!instance) instance = new MindManager();
  return instance;
}
