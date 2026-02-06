import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "../lib/parse-args.js";
import { resolveAgent } from "../lib/registry.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    follow: { type: "boolean" },
    n: { type: "number" },
  });

  const name = positional[0];
  if (!name) {
    console.error("Usage: volute logs <name> [--follow] [-n N]");
    process.exit(1);
  }

  const { dir } = resolveAgent(name);
  const logFile = resolve(dir, ".volute", "logs", "supervisor.log");

  if (!existsSync(logFile)) {
    console.error(`No log file found. Has ${name} been started?`);
    process.exit(1);
  }

  const tailArgs = [`-n`, String(flags.n ?? 50), ...(flags.follow ? ["-f"] : []), logFile];

  const child = spawn("tail", tailArgs, { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}
