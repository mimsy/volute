import { existsSync } from "node:fs";
import { exec, execInherit } from "../lib/exec.js";
import { parseArgs } from "../lib/parse-args.js";
import { addAgent, agentDir, ensureVoluteHome, nextPort } from "../lib/registry.js";
import { applyInitFiles, copyTemplateToDir, findTemplatesDir } from "../lib/template.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    template: { type: "string" },
  });

  const name = positional[0];
  const template = flags.template ?? "agent-sdk";

  if (!name) {
    console.error("Usage: volute create <name> [--template <name>]");
    process.exit(1);
  }

  ensureVoluteHome();
  const dest = agentDir(name);

  if (existsSync(dest)) {
    console.error(`Agent already exists: ${name}`);
    process.exit(1);
  }

  const templateDir = findTemplatesDir(template);
  copyTemplateToDir(templateDir, dest, name);
  applyInitFiles(dest);

  // Assign port and register
  const port = nextPort();
  addAgent(name, port);

  // Install dependencies
  console.log("Installing dependencies...");
  await execInherit("npm", ["install"], { cwd: dest });

  // git init + initial commit (after install so lockfile is included)
  await exec("git", ["init"], { cwd: dest });
  await exec("git", ["add", "-A"], { cwd: dest });
  await exec("git", ["commit", "-m", "initial commit"], { cwd: dest });

  console.log(`\nCreated agent: ${name} (port ${port})`);
  console.log(`\n  volute start ${name}`);
}
