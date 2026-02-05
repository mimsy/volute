import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { exec, execInherit } from "../lib/exec.js";
import { parseArgs } from "../lib/parse-args.js";
import { resolveAgent } from "../lib/registry.js";
import { spawnServer } from "../lib/spawn-server.js";
import { copyTemplateToDir, findTemplatesDir } from "../lib/template.js";
import { addVariant, checkHealth } from "../lib/variants.js";

const TEMPLATE_BRANCH = "molt/template";
const VARIANT_NAME = "upgrade";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    template: { type: "string" },
    continue: { type: "boolean" },
  });

  const agentName = positional[0];
  if (!agentName) {
    console.error("Usage: molt upgrade <name> [--template <name>] [--continue]");
    process.exit(1);
  }

  const { dir: projectRoot } = resolveAgent(agentName);
  const template = flags.template ?? "agent-sdk";

  if (flags.continue) {
    await continueUpgrade(agentName, projectRoot);
    return;
  }

  const templateDir = findTemplatesDir(template);
  const worktreeDir = resolve(projectRoot, ".worktrees", VARIANT_NAME);

  if (existsSync(worktreeDir)) {
    console.error(
      `Upgrade worktree already exists: ${worktreeDir}\n` +
        `If a previous upgrade is in progress, use --continue to finish it.\n` +
        `Otherwise, remove it with: git -C ${projectRoot} worktree remove .worktrees/${VARIANT_NAME}`,
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
  await updateTemplateBranch(projectRoot, templateDir, agentName);

  // Step 2: Create upgrade worktree
  console.log("Creating upgrade variant...");
  const parentDir = resolve(projectRoot, ".worktrees");
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
    console.log(`  molt upgrade ${agentName} --continue`);
    return;
  }

  // Step 4: Install, start, verify
  await installAndVerify(agentName, projectRoot, worktreeDir);
}

/**
 * Update the molt/template orphan branch with the latest template files.
 * Uses a temporary worktree to avoid touching the main working directory.
 */
async function updateTemplateBranch(projectRoot: string, templateDir: string, agentName: string) {
  const tempWorktree = resolve(projectRoot, ".worktrees", "_template_update");

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

    // Copy template files to the worktree
    copyTemplateToDir(templateDir, tempWorktree, agentName);

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
  const worktreeDir = resolve(projectRoot, ".worktrees", VARIANT_NAME);

  if (!existsSync(worktreeDir)) {
    console.error("No upgrade in progress. Run `molt upgrade` first.");
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

  await installAndVerify(agentName, projectRoot, worktreeDir);
}

/**
 * Install dependencies, start the variant server, and run verification.
 */
async function installAndVerify(agentName: string, projectRoot: string, worktreeDir: string) {
  // Install dependencies
  console.log("Installing dependencies...");
  await execInherit("npm", ["install"], { cwd: worktreeDir });

  // Start variant server
  console.log("Starting upgrade variant...");
  const result = await spawnServer(worktreeDir, 0, { detached: true });
  if (!result) {
    console.error("Server failed to start within timeout");
    process.exit(1);
  }

  const { actualPort, child } = result;
  const pid = child.pid ?? null;

  // Register variant
  addVariant(projectRoot, {
    name: VARIANT_NAME,
    branch: VARIANT_NAME,
    path: worktreeDir,
    port: actualPort,
    pid,
    created: new Date().toISOString(),
  });

  // Verify
  console.log("Verifying upgrade...");
  const verified = await verify(actualPort);

  if (verified) {
    console.log("\nUpgrade variant is healthy and responding.");
  } else {
    console.log("\nWarning: Verification failed. The variant may need attention.");
  }

  console.log(`\nUpgrade variant running on port ${actualPort}`);
  console.log(`\nNext steps:`);
  console.log(`  molt send ${agentName}@${VARIANT_NAME} "hello"    # chat with upgraded variant`);
  console.log(`  molt merge ${agentName} ${VARIANT_NAME}           # merge back when satisfied`);
}

/**
 * Verify the upgrade variant by checking health and sending a test message.
 */
async function verify(port: number): Promise<boolean> {
  // Health check
  const health = await checkHealth(port);
  if (!health.ok) {
    console.error("Health check failed");
    return false;
  }
  console.log("  Health check: OK");

  // Send test message
  try {
    const res = await fetch(`http://localhost:${port}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: [{ type: "text", text: "ping" }],
        channel: "system",
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok || !res.body) {
      console.error("  Test message: failed to send");
      return false;
    }

    // Read ndjson stream looking for a done event
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let gotDone = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "done") {
            gotDone = true;
          }
        } catch {
          // skip invalid lines
        }
      }

      if (gotDone) {
        reader.cancel();
        break;
      }
    }

    if (gotDone) {
      console.log("  Test message: OK");
      return true;
    } else {
      console.error("  Test message: no done event received");
      return false;
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  Test message: ${msg}`);
    return false;
  }
}
