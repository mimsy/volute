import { spawn, execFile } from "child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";

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

  function cleanupPidFile() {
    try { unlinkSync(pidPath); } catch {}
  }
  process.on("exit", cleanupPidFile);
  process.on("SIGINT", () => { cleanupPidFile(); process.exit(0); });
  process.on("SIGTERM", () => { cleanupPidFile(); process.exit(0); });

  function tsxBin(): string {
    return resolve(agentDir, "node_modules", ".bin", "tsx");
  }

  const portArgs = ["--port", String(port)];

  function startAgent(): ReturnType<typeof spawn> {
    if (dev) {
      console.error(`[supervisor] starting agent server in dev mode (watching for changes)...`);
      return spawn(tsxBin(), ["watch", "src/server.ts", ...portArgs], {
        cwd: agentDir,
        stdio: "inherit",
      });
    }
    console.error(`[supervisor] starting agent server...`);
    return spawn(tsxBin(), ["src/server.ts", ...portArgs], {
      cwd: agentDir,
      stdio: "inherit",
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

    child.on("exit", (code) => {
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
