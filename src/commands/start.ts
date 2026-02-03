import { spawn } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";

export async function run(args: string[]) {
  const supervisorPath = resolve(process.cwd(), "supervisor.ts");

  if (!existsSync(supervisorPath)) {
    console.error("No supervisor.ts found. Are you in an agent project directory?");
    process.exit(1);
  }

  const dev = args.includes("--dev");
  const tsxBin = resolve(process.cwd(), "node_modules", ".bin", "tsx");
  const supervisorArgs = dev ? [supervisorPath, "--dev"] : [supervisorPath];
  const child = spawn(tsxBin, supervisorArgs, {
    cwd: process.cwd(),
    stdio: "inherit",
  });

  child.on("exit", (code) => {
    process.exit(code ?? 1);
  });
}
