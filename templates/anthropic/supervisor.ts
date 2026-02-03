import { spawn, execFileSync } from "child_process";
import { readFileSync, unlinkSync, existsSync } from "fs";
import { resolve } from "path";

const projectRoot = process.cwd();
const restartSignalPath = resolve(projectRoot, ".molt/restart.json");

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
        execFileSync("molt", ["merge", signal.name], { cwd: projectRoot, stdio: "inherit" });
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
