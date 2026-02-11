import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { exec, execInherit } from "../lib/exec.js";
import { chownAgentDir, createAgentUser, ensureVoluteGroup } from "../lib/isolation.js";
import { parseArgs } from "../lib/parse-args.js";
import { addAgent, agentDir, ensureVoluteHome, nextPort } from "../lib/registry.js";
import {
  applyInitFiles,
  composeTemplate,
  copyTemplateToDir,
  findTemplatesRoot,
  listFiles,
  type TemplateManifest,
} from "../lib/template.js";

const TEMPLATE_BRANCH = "volute/template";

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

    // Assign port and register
    const port = nextPort();
    addAgent(name, port);

    // Install dependencies
    console.log("Installing dependencies...");
    await execInherit("npm", ["install"], { cwd: dest });

    // git init + template branch + initial commit (after install so lockfile is included)
    try {
      await exec("git", ["init"], { cwd: dest });
      await initTemplateBranch(dest, composedDir, manifest);
    } catch (err) {
      // Clean up partial git state so the repo isn't left on an orphan branch
      rmSync(resolve(dest, ".git"), { recursive: true, force: true });
      console.warn(
        "\nWarning: git setup failed — variants and upgrades won't be available.",
        "\nTo fix: ensure git is installed with user.name/user.email configured.",
      );
      console.warn("Details:", (err as Error).message ?? err);
    }

    // Set up per-agent user isolation (no-ops if VOLUTE_ISOLATION !== "user")
    ensureVoluteGroup();
    createAgentUser(name);
    chownAgentDir(dest, name);

    console.log(`\nCreated agent: ${name} (port ${port})`);
    console.log(`\n  volute agent start ${name}`);
  } finally {
    rmSync(composedDir, { recursive: true, force: true });
  }
}

/**
 * Create the volute/template tracking branch and main branch with shared history.
 * This enables clean 3-way merges on the first `volute agent upgrade`.
 */
async function initTemplateBranch(
  projectRoot: string,
  composedDir: string,
  manifest: TemplateManifest,
) {
  // Compute template file paths (after renames, excluding .init/ identity files)
  const templateFiles = listFiles(composedDir)
    .filter((f) => !f.startsWith(".init/") && !f.startsWith(".init\\"))
    .map((f) => manifest.rename[f] ?? f);

  // Create orphan template branch with only template files
  await exec("git", ["checkout", "--orphan", TEMPLATE_BRANCH], { cwd: projectRoot });
  await exec("git", ["add", "--", ...templateFiles], { cwd: projectRoot });
  await exec("git", ["commit", "-m", "template update"], { cwd: projectRoot });

  // Create main from template branch (shared history enables clean upgrades)
  await exec("git", ["checkout", "-b", "main"], { cwd: projectRoot });
  await exec("git", ["add", "-A"], { cwd: projectRoot });
  await exec("git", ["commit", "-m", "initial commit"], { cwd: projectRoot });
}
