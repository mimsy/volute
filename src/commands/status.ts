import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { readRegistry, agentDir } from "../lib/registry.js";
import { checkHealth } from "../lib/variants.js";

export async function run(args: string[]) {
  const name = args[0];

  if (!name) {
    // List all agents
    const entries = readRegistry();
    if (entries.length === 0) {
      console.log("No agents registered. Create one with: molt create <name>");
      return;
    }

    const nameW = Math.max(4, ...entries.map((e) => e.name.length));
    const portW = Math.max(4, ...entries.map((e) => String(e.port).length));

    console.log(`${"NAME".padEnd(nameW)}  ${"PORT".padEnd(portW)}  STATUS    DISCORD`);

    for (const entry of entries) {
      const dir = agentDir(entry.name);
      let status = "stopped";

      // Check supervisor PID
      const pidPath = resolve(dir, ".molt", "supervisor.pid");
      if (existsSync(pidPath)) {
        const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
        try {
          process.kill(pid, 0);
          // Supervisor is running, check server health
          const health = await checkHealth(entry.port);
          status = health.ok ? "running" : "starting";
        } catch {
          status = "stopped";
        }
      }

      // Check Discord connector PID
      let discord = "-";
      const discordPidPath = resolve(dir, ".molt", "discord.pid");
      if (existsSync(discordPidPath)) {
        const dpid = parseInt(readFileSync(discordPidPath, "utf-8").trim(), 10);
        try {
          process.kill(dpid, 0);
          discord = "connected";
        } catch {
          // Stale PID
        }
      }

      console.log(`${entry.name.padEnd(nameW)}  ${String(entry.port).padEnd(portW)}  ${status.padEnd(8)}  ${discord}`);
    }
    return;
  }

  // Single agent status
  const entries = readRegistry();
  const entry = entries.find((e) => e.name === name);
  if (!entry) {
    console.error(`Unknown agent: ${name}`);
    process.exit(1);
  }

  const dir = agentDir(name);
  const port = entry.port;

  // Check supervisor PID
  const pidPath = resolve(dir, ".molt", "supervisor.pid");
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

  // Check Discord connector PID
  const discordPidPath = resolve(dir, ".molt", "discord.pid");
  let discordRunning = false;
  let discordPid: number | null = null;

  if (existsSync(discordPidPath)) {
    discordPid = parseInt(readFileSync(discordPidPath, "utf-8").trim(), 10);
    try {
      process.kill(discordPid, 0);
      discordRunning = true;
    } catch {
      // Stale PID
    }
  }

  console.log(`Discord: ${discordRunning ? `running (pid ${discordPid})` : "not connected"}`);

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
      console.error(`\nTry: molt start ${name}`);
    }
    process.exit(1);
  }
}
