import { spawn } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";
import { parseArgs } from "../lib/parse-args.js";
import { resolveAgent } from "../lib/registry.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    follow: { type: "boolean" },
    n: { type: "number" },
  });

  const name = positional[0];
  if (!name) {
    console.error("Usage: molt logs <name> [--follow] [-n N]");
    process.exit(1);
  }

  const { dir } = resolveAgent(name);
  const logFile = resolve(dir, ".molt", "logs", "supervisor.log");

  if (!existsSync(logFile)) {
    console.error(`No log file found. Has ${name} been started?`);
    process.exit(1);
  }

  const tailArgs = [
    `-n`, String(flags.n ?? 50),
    ...(flags.follow ? ["-f"] : []),
    logFile,
  ];

  const child = spawn("tail", tailArgs, { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}
