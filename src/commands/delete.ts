import { existsSync, readFileSync, rmSync } from "fs";
import { resolve } from "path";
import { findAgent, removeAgent, agentDir } from "../lib/registry.js";
import { parseArgs } from "../lib/parse-args.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    force: { type: "boolean" },
  });

  const name = positional[0];
  if (!name) {
    console.error("Usage: molt delete <name> [--force]");
    process.exit(1);
  }

  const entry = findAgent(name);
  if (!entry) {
    console.error(`Unknown agent: ${name}`);
    process.exit(1);
  }

  const dir = agentDir(name);

  // Stop if running
  const pidPath = resolve(dir, ".molt", "supervisor.pid");
  if (existsSync(pidPath)) {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    try {
      process.kill(pid, 0);
      console.log(`Stopping ${name}...`);
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        process.kill(pid, "SIGTERM");
      }
      // Wait for shutdown
      const start = Date.now();
      while (Date.now() - start < 5_000) {
        try {
          process.kill(pid, 0);
          await new Promise((r) => setTimeout(r, 200));
        } catch {
          break;
        }
      }
    } catch {
      // Not running
    }
  }

  // Remove from registry
  removeAgent(name);
  console.log(`Removed ${name} from registry.`);

  // Delete directory
  if (existsSync(dir)) {
    if (!flags.force) {
      console.log(`Directory: ${dir}`);
      console.log("Use --force to also delete the agent directory.");
    } else {
      rmSync(dir, { recursive: true, force: true });
      console.log(`Deleted ${dir}`);
    }
  }
}
