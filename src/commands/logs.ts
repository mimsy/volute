import { spawn } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";
import { parseArgs } from "../lib/parse-args.js";

export async function run(args: string[]) {
  const { flags } = parseArgs(args, {
    follow: { type: "boolean" },
    n: { type: "number" },
  });

  const logFile = resolve(process.cwd(), ".molt", "logs", "supervisor.log");

  if (!existsSync(logFile)) {
    console.error("No log file found. Has the agent been started?");
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
