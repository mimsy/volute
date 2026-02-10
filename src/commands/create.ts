import { existsSync, rmSync } from "node:fs";
import { exec, execInherit } from "../lib/exec.js";
import { chownAgentDir, createAgentUser, ensureVoluteGroup } from "../lib/isolation.js";
import { parseArgs } from "../lib/parse-args.js";
import { addAgent, agentDir, ensureVoluteHome, nextPort } from "../lib/registry.js";
import {
  applyInitFiles,
  composeTemplate,
  copyTemplateToDir,
  findTemplatesRoot,
} from "../lib/template.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    template: { type: "string" },
  });

  const name = positional[0];
  const template = flags.template ?? "agent-sdk";

  if (!name) {
    console.error("Usage: volute agent create <name> [--template <name>]");
    process.exit(1);
  }

  ensureVoluteHome();
  const dest = agentDir(name);

  if (existsSync(dest)) {
    console.error(`Agent already exists: ${name}`);
    process.exit(1);
  }

  const templatesRoot = findTemplatesRoot();
  const { composedDir, manifest } = composeTemplate(templatesRoot, template);

  try {
    copyTemplateToDir(composedDir, dest, name, manifest);
    applyInitFiles(dest);
  } finally {
    rmSync(composedDir, { recursive: true, force: true });
  }

  // Assign port and register
  const port = nextPort();
  addAgent(name, port);

  // Install dependencies
  console.log("Installing dependencies...");
  await execInherit("npm", ["install"], { cwd: dest });

  // git init + initial commit (after install so lockfile is included)
  try {
    await exec("git", ["init"], { cwd: dest });
    await exec("git", ["add", "-A"], { cwd: dest });
    await exec("git", ["commit", "-m", "initial commit"], { cwd: dest });
  } catch {
    console.warn(
      "\nWarning: git init failed (git may not be installed or configured).",
      "\nThe agent will work, but forking/variants won't be available.",
      "\nTo fix: install git and run `git config --global user.name` / `git config --global user.email`",
    );
  }

  // Set up per-agent user isolation (no-ops if VOLUTE_ISOLATION !== "user")
  ensureVoluteGroup();
  createAgentUser(name);
  chownAgentDir(dest, name);

  console.log(`\nCreated agent: ${name} (port ${port})`);
  console.log(`\n  volute agent start ${name}`);
}
