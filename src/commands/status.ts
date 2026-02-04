import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { parseArgs } from "../lib/parse-args.js";

export async function run(args: string[]) {
  const { flags } = parseArgs(args, {
    port: { type: "number" },
  });

  const port = flags.port ?? 4100;

  // Check supervisor PID
  const pidPath = resolve(process.cwd(), ".molt", "supervisor.pid");
  let supervisorRunning = false;
  let supervisorPid: number | null = null;

  if (existsSync(pidPath)) {
    supervisorPid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    try {
      process.kill(supervisorPid, 0);
      supervisorRunning = true;
    } catch {
      // Stale PID
    }
  }

  console.log(`Supervisor: ${supervisorRunning ? `running (pid ${supervisorPid})` : "not running"}`);

  // Check server health
  const url = `http://localhost:${port}/health`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`Server: unhealthy (${res.status})`);
      process.exit(1);
    }
    const data = (await res.json()) as { name: string; version: string; status: string };
    console.log(`Server: ${data.status} on port ${port}`);
    console.log(`Agent: ${data.name} v${data.version}`);
  } catch {
    console.log(`Server: not responding on port ${port}`);
    if (!supervisorRunning) {
      console.error("\nTry: molt start");
    }
    process.exit(1);
  }
}
