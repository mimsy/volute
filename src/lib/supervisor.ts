import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadMergedEnv } from "./env.js";

export type SupervisorOptions = {
  agentName: string;
  agentDir: string;
  port: number;
  dev?: boolean;
};

/**
 * Run the supervisor in the current process (foreground mode).
 * Spawns the agent server, handles crash recovery and merge-restart signals.
 */
export function runSupervisor(opts: SupervisorOptions): void {
  const { agentName, agentDir, port, dev } = opts;
  const moltDir = resolve(agentDir, ".molt");
  const restartSignalPath = resolve(moltDir, "restart.json");
  const pidPath = resolve(moltDir, "supervisor.pid");

  // Write PID file
  mkdirSync(moltDir, { recursive: true });
  writeFileSync(pidPath, String(process.pid));

  let shuttingDown = false;
  let activeChild: ReturnType<typeof spawn> | null = null;

  function cleanupPidFile() {
    try {
      unlinkSync(pidPath);
    } catch {}
  }
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (activeChild) {
      try {
        activeChild.kill("SIGTERM");
      } catch {}
    }
    cleanupPidFile();
    process.exit(0);
  }
  process.on("exit", cleanupPidFile);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  function tsxBin(): string {
    return resolve(agentDir, "node_modules", ".bin", "tsx");
  }

  const portArgs = ["--port", String(port)];

  function startAgent(): ReturnType<typeof spawn> {
    const agentEnv = loadMergedEnv(agentDir);
    const env = { ...process.env, ...agentEnv, MOLT_AGENT: agentName };

    if (dev) {
      console.error(`[supervisor] starting agent server in dev mode (watching for changes)...`);
      return spawn(tsxBin(), ["watch", "src/server.ts", ...portArgs], {
        cwd: agentDir,
        stdio: "inherit",
        env,
      });
    }
    console.error(`[supervisor] starting agent server...`);
    return spawn(tsxBin(), ["src/server.ts", ...portArgs], {
      cwd: agentDir,
      stdio: "inherit",
      env,
    });
  }

  function handleRestart(): boolean {
    if (!existsSync(restartSignalPath)) return false;

    try {
      const signal = JSON.parse(readFileSync(restartSignalPath, "utf-8"));
      unlinkSync(restartSignalPath);

      if (signal.action === "merge" && signal.name) {
        console.error(`[supervisor] merging variant: ${signal.name}`);
        try {
          const mergeArgs = ["merge", agentName, signal.name];
          if (signal.summary) mergeArgs.push("--summary", signal.summary);
          if (signal.justification) mergeArgs.push("--justification", signal.justification);
          if (signal.memory) mergeArgs.push("--memory", signal.memory);
          execFile("molt", mergeArgs, {
            cwd: agentDir,
            env: { ...process.env, MOLT_SUPERVISOR: "1" },
          });
        } catch (e) {
          console.error(`[supervisor] molt merge failed:`, e);
        }
      }

      return true;
    } catch (e) {
      console.error(`[supervisor] failed to read restart signal:`, e);
      return false;
    }
  }

  function run() {
    const child = startAgent();
    activeChild = child;

    child.on("exit", (code) => {
      activeChild = null;
      if (shuttingDown) return;

      console.error(`[supervisor] agent exited with code ${code}`);

      const wasRestart = handleRestart();
      if (wasRestart) {
        console.error(`[supervisor] restarting immediately after merge`);
        run();
      } else {
        console.error(`[supervisor] crash recovery — restarting in 3s`);
        setTimeout(run, 3000);
      }
    });
  }

  run();
}
