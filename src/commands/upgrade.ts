import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { daemonFetch } from "../lib/daemon-client.js";
import { exec, execInherit } from "../lib/exec.js";
import { parseArgs } from "../lib/parse-args.js";
import { nextPort, resolveAgent } from "../lib/registry.js";
import { composeTemplate, copyTemplateToDir, findTemplatesRoot } from "../lib/template.js";
import { addVariant } from "../lib/variants.js";

const TEMPLATE_BRANCH = "volute/template";
const VARIANT_NAME = "upgrade";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    template: { type: "string" },
    continue: { type: "boolean" },
  });

  const agentName = positional[0];
  if (!agentName) {
    console.error("Usage: volute upgrade <name> [--template <name>] [--continue]");
    process.exit(1);
  }

  const { dir: projectRoot } = resolveAgent(agentName);
  const template = flags.template ?? "agent-sdk";

  if (flags.continue) {
    await continueUpgrade(agentName, projectRoot);
    return;
  }

  const worktreeDir = resolve(projectRoot, ".variants", VARIANT_NAME);

  if (existsSync(worktreeDir)) {
    console.error(
      `Upgrade variant already exists: ${worktreeDir}\n` +
        `If a previous upgrade is in progress, use --continue to finish it.\n` +
        `Otherwise, remove it with: volute variant delete ${VARIANT_NAME} --agent ${agentName}`,
    );
    process.exit(1);
  }

  // Clean up stale worktree refs and leftover upgrade branch
  await exec("git", ["worktree", "prune"], { cwd: projectRoot });
  try {
    await exec("git", ["branch", "-D", VARIANT_NAME], { cwd: projectRoot });
  } catch {
    // branch doesn't exist, that's fine
  }

  // Step 1: Update the template tracking branch
  console.log("Updating template branch...");
  await updateTemplateBranch(projectRoot, template, agentName);

  // Step 2: Create upgrade worktree
  console.log("Creating upgrade variant...");
  const parentDir = resolve(projectRoot, ".variants");
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  await exec("git", ["worktree", "add", "-b", VARIANT_NAME, worktreeDir], {
    cwd: projectRoot,
  });

  // Step 3: Merge template branch
  console.log("Merging template changes...");
  const hasConflicts = await mergeTemplateBranch(worktreeDir);

  if (hasConflicts) {
    console.log("\nMerge conflicts detected. Resolve them in:");
    console.log(`  ${worktreeDir}`);
    console.log(`\nThen run:`);
    console.log(`  volute upgrade ${agentName} --continue`);
    return;
  }

  // Step 4: Install, start, verify
  await installAndVerify(agentName, worktreeDir);
}

/**
 * Update the volute/template orphan branch with the latest template files.
 * Uses a temporary worktree to avoid touching the main working directory.
 */
async function updateTemplateBranch(projectRoot: string, template: string, agentName: string) {
  const tempWorktree = resolve(projectRoot, ".variants", "_template_update");

  // Check if template branch exists
  let branchExists = false;
  try {
    await exec("git", ["rev-parse", "--verify", TEMPLATE_BRANCH], {
      cwd: projectRoot,
    });
    branchExists = true;
  } catch {
    // branch doesn't exist
  }

  // Clean up any existing temp worktree
  try {
    await exec("git", ["worktree", "remove", "--force", tempWorktree], { cwd: projectRoot });
  } catch {
    // doesn't exist, that's fine
  }
  if (existsSync(tempWorktree)) {
    rmSync(tempWorktree, { recursive: true, force: true });
  }

  // Compose template
  const templatesRoot = findTemplatesRoot();
  const { composedDir, manifest } = composeTemplate(templatesRoot, template);

  try {
    if (branchExists) {
      // Create worktree for existing branch
      await exec("git", ["worktree", "add", tempWorktree, TEMPLATE_BRANCH], {
        cwd: projectRoot,
      });
    } else {
      // Create orphan branch via worktree
      // First create an empty commit to bootstrap the branch
      await exec("git", ["worktree", "add", "--detach", tempWorktree], {
        cwd: projectRoot,
      });
      await exec("git", ["checkout", "--orphan", TEMPLATE_BRANCH], {
        cwd: tempWorktree,
      });
      await exec("git", ["rm", "-rf", "--cached", "."], { cwd: tempWorktree });
      await exec("git", ["clean", "-fd"], { cwd: tempWorktree });
    }

    // Remove existing tracked files in the worktree
    if (branchExists) {
      await exec("git", ["rm", "-rf", "."], { cwd: tempWorktree }).catch(() => {});
    }

    // Copy composed template files to the worktree
    copyTemplateToDir(composedDir, tempWorktree, agentName, manifest);

    // Remove .init/ — those files are only for agent creation, not upgrades
    const initDir = resolve(tempWorktree, ".init");
    if (existsSync(initDir)) {
      rmSync(initDir, { recursive: true, force: true });
    }

    // Stage and commit
    await exec("git", ["add", "-A"], { cwd: tempWorktree });

    // Check if there are changes to commit
    try {
      await exec("git", ["diff", "--cached", "--quiet"], { cwd: tempWorktree });
      // No changes — template is already up to date
      console.log("Template branch is already up to date.");
    } catch {
      // There are changes to commit
      await exec("git", ["commit", "-m", "template update"], {
        cwd: tempWorktree,
      });
    }
  } finally {
    // Clean up temp worktree
    try {
      await exec("git", ["worktree", "remove", "--force", tempWorktree], { cwd: projectRoot });
    } catch {
      // Best effort cleanup
    }
    if (existsSync(tempWorktree)) {
      rmSync(tempWorktree, { recursive: true, force: true });
    }
    // Clean up composed template
    rmSync(composedDir, { recursive: true, force: true });
  }
}

/**
 * Merge the template branch into the current worktree.
 * Returns true if there are conflicts.
 */
async function mergeTemplateBranch(worktreeDir: string): Promise<boolean> {
  try {
    await exec(
      "git",
      ["merge", TEMPLATE_BRANCH, "--allow-unrelated-histories", "-m", "merge template update"],
      { cwd: worktreeDir },
    );
    return false;
  } catch (e: unknown) {
    // Check if there are actually conflicts vs some other error
    try {
      const status = await exec("git", ["status", "--porcelain"], {
        cwd: worktreeDir,
      });
      const hasConflictMarkers = status
        .split("\n")
        .some((line) => line.startsWith("UU") || line.startsWith("AA"));
      if (hasConflictMarkers) return true;
    } catch {
      // fall through to rethrow
    }
    throw e;
  }
}

/**
 * Continue an upgrade after conflict resolution.
 */
async function continueUpgrade(agentName: string, projectRoot: string) {
  const worktreeDir = resolve(projectRoot, ".variants", VARIANT_NAME);

  if (!existsSync(worktreeDir)) {
    console.error("No upgrade in progress. Run `volute upgrade` first.");
    process.exit(1);
  }

  // Check for unresolved conflicts
  const status = await exec("git", ["status", "--porcelain"], {
    cwd: worktreeDir,
  });
  const hasConflicts = status
    .split("\n")
    .some((line) => line.startsWith("UU") || line.startsWith("AA"));

  if (hasConflicts) {
    console.error("There are still unresolved conflicts. Resolve them first.");
    process.exit(1);
  }

  // Commit the merge resolution
  try {
    await exec("git", ["add", "-A"], { cwd: worktreeDir });
    await exec("git", ["commit", "--no-edit"], { cwd: worktreeDir });
  } catch {
    // commit may already be done if user committed manually
  }

  await installAndVerify(agentName, worktreeDir);
}

/**
 * Install dependencies, start the variant server, and run verification.
 */
async function installAndVerify(agentName: string, worktreeDir: string) {
  // Install dependencies
  console.log("Installing dependencies...");
  await execInherit("npm", ["install"], { cwd: worktreeDir });

  const variantPort = nextPort();

  // Register variant
  addVariant(agentName, {
    name: VARIANT_NAME,
    branch: VARIANT_NAME,
    path: worktreeDir,
    port: variantPort,
    created: new Date().toISOString(),
  });

  // Start variant via daemon
  console.log("Starting upgrade variant...");
  try {
    const res = await daemonFetch(
      `/api/agents/${encodeURIComponent(`${agentName}@${VARIANT_NAME}`)}/start`,
      { method: "POST" },
    );
    if (!res.ok) {
      const data = (await res.json()) as { error?: string };
      console.error(data.error ?? "Failed to start variant");
      process.exit(1);
    }
  } catch {
    console.error("Failed to start variant. Is the daemon running? (volute up)");
    console.error(
      "The variant was created but not started. Use: volute start " +
        `${agentName}@${VARIANT_NAME}`,
    );
    process.exit(1);
  }

  console.log(`\nUpgrade variant running on port ${variantPort}`);
  console.log(`\nNext steps:`);
  console.log(`  volute send ${agentName}@${VARIANT_NAME} "hello"    # chat with upgraded variant`);
  console.log(`  volute variant merge ${VARIANT_NAME}                # merge back when satisfied`);
}
