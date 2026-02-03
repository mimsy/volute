import { spawn, execFileSync } from "child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";

const projectRoot = process.cwd();
const moltDir = resolve(projectRoot, ".molt");
const restartSignalPath = resolve(moltDir, "restart.json");
const pidPath = resolve(moltDir, "supervisor.pid");

// Write PID file so CLI can find us
if (!existsSync(moltDir)) mkdirSync(moltDir, { recursive: true });
writeFileSync(pidPath, String(process.pid));

function cleanupPidFile() {
  try { unlinkSync(pidPath); } catch {}
}
process.on("exit", cleanupPidFile);
process.on("SIGINT", () => { cleanupPidFile(); process.exit(0); });
process.on("SIGTERM", () => { cleanupPidFile(); process.exit(0); });

function tsxBin(): string {
  return resolve(projectRoot, "node_modules", ".bin", "tsx");
}

function startAgent(): ReturnType<typeof spawn> {
  console.error(`[supervisor] starting agent server...`);
  return spawn(tsxBin(), ["src/server.ts"], {
    cwd: projectRoot,
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
        execFileSync("molt", ["merge", signal.name], {
          cwd: projectRoot,
          stdio: "inherit",
          env: { ...process.env, MOLT_SUPERVISOR: "1" },
        });
        // Write merged.json so the restarted server knows what was merged
        writeFileSync(
          resolve(moltDir, "merged.json"),
          JSON.stringify({ name: signal.name }),
        );
      } catch (e) {
        console.error(`[supervisor] molt merge failed:`, e);
        // still restart even if merge fails
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
