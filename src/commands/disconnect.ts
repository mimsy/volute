import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { resolveAgent } from "../lib/registry.js";

export async function run(args: string[]) {
  const connector = args[0];
  if (connector !== "discord") {
    console.error("Usage: molt disconnect discord <agent>");
    process.exit(1);
  }

  const name = args[1];
  if (!name) {
    console.error("Usage: molt disconnect discord <agent>");
    process.exit(1);
  }

  const { dir } = resolveAgent(name);
  const pidPath = resolve(dir, ".molt", "discord.pid");

  if (!existsSync(pidPath)) {
    console.error(`Discord connector for ${name} is not running (no PID file found).`);
    process.exit(1);
  }

  const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);

  try {
    process.kill(pid, 0);
  } catch {
    try {
      unlinkSync(pidPath);
    } catch {}
    console.log(`Discord connector for ${name} was not running (cleaned up stale PID file).`);
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
    console.log(`Sent SIGTERM to Discord connector (pid ${pid})`);
  } catch {
    process.kill(pid, "SIGTERM");
    console.log(`Sent SIGTERM to Discord connector (pid ${pid})`);
  }

  // Wait for PID file cleanup
  const maxWait = 10_000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    if (!existsSync(pidPath)) {
      console.log(`Discord connector for ${name} stopped.`);
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  // Force kill
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already dead
    }
  }
  try {
    unlinkSync(pidPath);
  } catch {}
  console.error(`Discord connector for ${name} did not exit cleanly, sent SIGKILL.`);
}
