import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "../lib/parse-args.js";
import { resolveAgent, stateDir } from "../lib/registry.js";
import { resolveAgentName } from "../lib/resolve-agent-name.js";

export async function run(args: string[]) {
  const { flags } = parseArgs(args, {
    agent: { type: "string" },
    follow: { type: "boolean" },
    n: { type: "number" },
  });

  const name = resolveAgentName(flags);

  resolveAgent(name); // validate agent exists
  const logFile = resolve(stateDir(name), "logs", "agent.log");

  if (!existsSync(logFile)) {
    console.error(`No log file found. Has ${name} been started?`);
    process.exit(1);
  }

  const tailArgs = [`-n`, String(flags.n ?? 50), ...(flags.follow ? ["-f"] : []), logFile];

  const child = spawn("tail", tailArgs, { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}
