import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadMergedEnv } from "../lib/env.js";
import { parseArgs } from "../lib/parse-args.js";
import { resolveAgent } from "../lib/registry.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    foreground: { type: "boolean" },
  });

  const connector = positional[0];
  if (connector !== "discord") {
    console.error("Usage: molt connect discord <agent> [--foreground]");
    process.exit(1);
  }

  const name = positional[1];
  if (!name) {
    console.error("Usage: molt connect discord <agent> [--foreground]");
    process.exit(1);
  }

  const { dir } = resolveAgent(name);
  const env = loadMergedEnv(dir);

  if (!env.DISCORD_TOKEN) {
    console.error("DISCORD_TOKEN not set. Run: molt env set DISCORD_TOKEN <token>");
    process.exit(1);
  }

  // Check if already running
  const pidPath = resolve(dir, ".molt", "discord.pid");
  if (existsSync(pidPath)) {
    try {
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      process.kill(pid, 0);
      console.error(
        `Discord connector for ${name} already running (pid ${pid}). Use 'molt disconnect discord ${name}' first.`,
      );
      process.exit(1);
    } catch {
      // PID file is stale, continue
    }
  }

  if (flags.foreground) {
    const { run: runDiscord } = await import("./connect-discord.js");
    await runDiscord([name]);
    return;
  }

  // Find connect-discord module source
  let connectModule = "";
  let searchDir = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(searchDir, "src", "commands", "connect-discord.ts");
    if (existsSync(candidate)) {
      connectModule = candidate;
      break;
    }
    searchDir = dirname(searchDir);
  }

  if (!connectModule) {
    connectModule = resolve(
      dirname(new URL(import.meta.url).pathname),
      "..",
      "commands",
      "connect-discord.ts",
    );
  }

  const tsxBin = resolve(dir, "node_modules", ".bin", "tsx");
  const bootstrapCode = `
    import { run } from ${JSON.stringify(connectModule)};
    run([${JSON.stringify(name)}]);
  `;

  // Daemon mode: redirect output to log file
  const logsDir = resolve(dir, ".molt", "logs");
  mkdirSync(logsDir, { recursive: true });

  const logFile = resolve(logsDir, "discord.log");
  const logFd = openSync(logFile, "a");

  const child = spawn(tsxBin, ["--eval", bootstrapCode], {
    cwd: dir,
    stdio: ["ignore", logFd, logFd],
    detached: true,
    env: { ...process.env, ...env },
  });
  child.unref();

  // Monitor log file for "Connected to Discord" confirmation
  const maxWait = 30_000;
  const start = Date.now();

  // Wait a moment for the log file to start getting written
  await new Promise((r) => setTimeout(r, 500));

  while (Date.now() - start < maxWait) {
    try {
      const content = readFileSync(logFile, "utf-8");
      if (content.includes("Connected to Discord")) {
        console.log(`Discord connector for ${name} started (pid ${child.pid})`);
        console.log(`Logs: ${logFile}`);
        return;
      }
    } catch {
      // Log file not ready yet
    }

    // Check if the child already exited
    try {
      if (child.pid) process.kill(child.pid, 0);
    } catch {
      console.error("Discord connector exited unexpectedly.");
      console.error(`Check logs: ${logFile}`);
      process.exit(1);
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  // Timed out
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {}
    }
  }

  console.error("Discord connector did not start within 30s.");
  console.error(`Check logs: ${logFile}`);
  process.exit(1);
}
