import { spawn } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";

export async function run(_args: string[]) {
  const supervisorPath = resolve(process.cwd(), "supervisor.ts");

  if (!existsSync(supervisorPath)) {
    console.error("No supervisor.ts found. Are you in an agent project directory?");
    process.exit(1);
  }

  const child = spawn("bun", ["run", supervisorPath], {
    cwd: process.cwd(),
    stdio: "inherit",
  });

  child.on("exit", (code) => {
    process.exit(code ?? 1);
  });
}
