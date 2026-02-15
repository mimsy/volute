import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getClient, urlOf } from "../lib/api-client.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { exec, execInherit } from "../lib/exec.js";
import { parseArgs } from "../lib/parse-args.js";
import { nextPort, resolveAgent } from "../lib/registry.js";
import { resolveAgentName } from "../lib/resolve-agent-name.js";
import { spawnServer } from "../lib/spawn-server.js";
import {
  addVariant,
  checkHealth,
  findVariant,
  readVariants,
  removeVariant,
  type Variant,
  validateBranchName,
  writeVariants,
} from "../lib/variants.js";
import { verify } from "../lib/verify.js";

export async function run(args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case "create":
      await createVariant(args.slice(1));
      break;
    case "list":
      await listVariants(args.slice(1));
      break;
    case "merge":
      await mergeVariant(args.slice(1));
      break;
    case "delete":
      await deleteVariant(args.slice(1));
      break;
    case "--help":
    case "-h":
    case undefined:
      printUsage();
      break;
    default:
      printUsage();
      process.exit(1);
  }
}

function printUsage() {
  console.log(`Usage:
  volute variant create <variant> [--agent <name>] [--soul "..."] [--port N] [--no-start] [--json]
  volute variant list [--agent <name>] [--json]
  volute variant merge <variant> [--agent <name>] [--summary "..." --memory "..."] [--skip-verify]
  volute variant delete <variant> [--agent <name>]`);
}

async function createVariant(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    agent: { type: "string" },
    soul: { type: "string" },
    port: { type: "number" },
    "no-start": { type: "boolean" },
    json: { type: "boolean" },
  });

  const agentName = resolveAgentName(flags);
  const variantName = positional[0];
  const { soul, port, json } = flags;
  const noStart = flags["no-start"];

  if (!variantName) {
    console.error(
      'Usage: volute variant create <variant> [--agent <name>] [--soul "..."] [--port N] [--no-start] [--json]',
    );
    process.exit(1);
  }

  const err = validateBranchName(variantName);
  if (err) {
    console.error(err);
    process.exit(1);
  }

  const { dir: projectRoot } = resolveAgent(agentName);
  const variantDir = resolve(projectRoot, ".variants", variantName);

  if (existsSync(variantDir)) {
    console.error(`Variant directory already exists: ${variantDir}`);
    process.exit(1);
  }

  mkdirSync(resolve(projectRoot, ".variants"), { recursive: true });

  // Create git worktree
  try {
    await exec("git", ["worktree", "add", "-b", variantName, variantDir], { cwd: projectRoot });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Failed to create worktree: ${msg}`);
    process.exit(1);
  }

  // Install dependencies
  if (!json) console.log("Installing dependencies...");
  try {
    if (json) {
      await exec("npm", ["install"], { cwd: variantDir });
    } else {
      await execInherit("npm", ["install"], { cwd: variantDir });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`npm install failed: ${msg}`);
    process.exit(1);
  }

  // Write SOUL.md if provided
  if (soul) {
    writeFileSync(resolve(variantDir, "home/SOUL.md"), soul);
  }

  const variantPort = port ?? nextPort();

  const variant = {
    name: variantName,
    branch: variantName,
    path: variantDir,
    port: variantPort,
    created: new Date().toISOString(),
  };

  addVariant(agentName, variant);

  if (!noStart) {
    if (!json) console.log("Starting variant via daemon...");
    try {
      const client = getClient();
      const res = await daemonFetch(
        urlOf(
          client.api.agents[":name"].start.$url({
            param: { name: `${agentName}@${variantName}` },
          }),
        ),
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
        "The variant was created but not started. Use: volute agent start " +
          `${agentName}@${variantName}`,
      );
      process.exit(1);
    }
  }

  if (json) {
    console.log(JSON.stringify(variant, null, 2));
  } else {
    console.log(`\nVariant created: ${variantName}`);
    console.log(`  Branch: ${variant.branch}`);
    console.log(`  Path:   ${variant.path}`);
    console.log(`  Port:   ${variantPort}`);
  }
}

async function listVariants(args: string[]) {
  const { flags } = parseArgs(args, {
    agent: { type: "string" },
    json: { type: "boolean" },
  });

  const agentName = resolveAgentName(flags);
  const { json } = flags;
  resolveAgent(agentName); // validate agent exists
  const variants = readVariants(agentName);

  if (variants.length === 0) {
    if (json) {
      console.log("[]");
    } else {
      console.log("No variants.");
    }
    return;
  }

  // Health-check all variants in parallel
  const results: (Variant & { status: string })[] = await Promise.all(
    variants.map(async (v) => {
      if (!v.port) return { ...v, status: "no-server" };
      const health = await checkHealth(v.port);
      return { ...v, status: health.ok ? "running" : "dead" };
    }),
  );

  // Update variants.json to clear running status for dead variants
  const updated = results.map(({ status, ...v }) => ({
    ...v,
    running: status === "running",
  }));
  writeVariants(agentName, updated);

  if (json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // Print table
  const nameW = Math.max(4, ...results.map((r) => r.name.length));
  const portW = Math.max(4, ...results.map((r) => String(r.port || "-").length));

  console.log(`${"NAME".padEnd(nameW)}  ${"PORT".padEnd(portW)}  ${"STATUS".padEnd(10)}  BRANCH`);
  for (const r of results) {
    console.log(
      `${r.name.padEnd(nameW)}  ${String(r.port || "-").padEnd(portW)}  ${r.status.padEnd(10)}  ${r.branch}`,
    );
  }
}

async function mergeVariant(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    agent: { type: "string" },
    summary: { type: "string" },
    justification: { type: "string" },
    memory: { type: "string" },
    "skip-verify": { type: "boolean" },
  });

  const agentName = resolveAgentName(flags);
  const variantName = positional[0];
  if (!variantName) {
    console.error(
      "Usage: volute variant merge <variant> [--agent <name>] [--summary '...'] [--justification '...'] [--memory '...'] [--skip-verify]",
    );
    process.exit(1);
  }

  const { dir: projectRoot } = resolveAgent(agentName);
  const variant = findVariant(agentName, variantName);

  if (!variant) {
    console.error(`Unknown variant: ${variantName}`);
    process.exit(1);
  }

  const branchErr = validateBranchName(variant.branch);
  if (branchErr) {
    console.error(branchErr);
    process.exit(1);
  }

  // Auto-commit any uncommitted changes in the variant worktree
  if (existsSync(variant.path)) {
    const status = (await exec("git", ["status", "--porcelain"], { cwd: variant.path })).trim();
    if (status) {
      console.log("Committing uncommitted changes in variant...");
      try {
        await exec("git", ["add", "-A"], { cwd: variant.path });
        await exec("git", ["commit", "-m", "Auto-commit uncommitted changes before merge"], {
          cwd: variant.path,
        });
      } catch (err) {
        console.error("Failed to auto-commit variant changes:", err);
        console.error("Please commit or stash changes in the variant manually before merging.");
        process.exit(1);
      }
    }
  }

  // Verify variant before merge
  if (!flags["skip-verify"]) {
    console.log("Verifying variant...");

    console.log("Starting temporary server for verification...");
    const result = await spawnServer(variant.path, 0, { detached: true });
    if (!result) {
      console.error("Failed to start server for verification. Use --skip-verify to skip.");
      process.exit(1);
    }

    const verified = await verify(result.actualPort);

    try {
      process.kill(result.child.pid!);
    } catch {}

    if (!verified) {
      console.error("Verification failed. Fix issues or use --skip-verify to proceed anyway.");
      process.exit(1);
    }

    console.log("Verification passed.");
  }

  // Auto-commit any uncommitted changes in the main worktree
  const mainStatus = (await exec("git", ["status", "--porcelain"], { cwd: projectRoot })).trim();
  if (mainStatus) {
    console.log("Committing uncommitted changes in main...");
    try {
      await exec("git", ["add", "-A"], { cwd: projectRoot });
      await exec("git", ["commit", "-m", "Auto-commit uncommitted changes before merge"], {
        cwd: projectRoot,
      });
    } catch (err) {
      console.error("Failed to auto-commit main changes:", err);
      console.error("Please commit or stash your changes manually before merging.");
      process.exit(1);
    }
  }

  // Merge branch
  console.log(`Merging branch: ${variant.branch}`);
  try {
    await execInherit("git", ["merge", variant.branch], { cwd: projectRoot });
  } catch (e) {
    console.error("Merge failed:", e);
    process.exit(1);
  }

  // Remove worktree
  if (existsSync(variant.path)) {
    try {
      await exec("git", ["worktree", "remove", "--force", variant.path], { cwd: projectRoot });
    } catch {
      // Best effort
    }
  }

  // Delete branch
  try {
    await exec("git", ["branch", "-D", variant.branch], { cwd: projectRoot });
  } catch {
    // Best effort
  }

  // Remove from variants.json
  removeVariant(agentName, variantName);

  // Reinstall dependencies
  console.log("Reinstalling dependencies...");
  try {
    await execInherit("npm", ["install"], { cwd: projectRoot });
  } catch (e) {
    console.error("npm install failed:", e);
  }

  console.log(`Variant ${variantName} merged and cleaned up.`);

  // If running under daemon (VOLUTE_SUPERVISOR env), the daemon handles restart and context delivery
  if (process.env.VOLUTE_SUPERVISOR) return;

  // Restart agent via daemon API with merge context
  const context = {
    type: "merged",
    name: variantName,
    ...(flags.summary && { summary: flags.summary }),
    ...(flags.justification && { justification: flags.justification }),
    ...(flags.memory && { memory: flags.memory }),
  };
  try {
    console.log("Restarting agent via daemon...");
    const client = getClient();
    const res = await daemonFetch(
      urlOf(client.api.agents[":name"].restart.$url({ param: { name: agentName } })),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context }),
      },
    );
    if (res.ok) {
      console.log(`${agentName} restarted.`);
    } else {
      const data = (await res.json()) as { error?: string };
      console.error(`Failed to restart: ${data.error ?? "unknown error"}`);
    }
  } catch {
    console.log(`Daemon not running. Start the agent manually: volute agent start ${agentName}`);
  }
}

async function deleteVariant(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    agent: { type: "string" },
  });

  const agentName = resolveAgentName(flags);
  const variantName = positional[0];
  if (!variantName) {
    console.error("Usage: volute variant delete <variant> [--agent <name>]");
    process.exit(1);
  }

  const { dir: projectRoot } = resolveAgent(agentName);
  const variant = findVariant(agentName, variantName);

  if (!variant) {
    console.error(`Unknown variant: ${variantName}`);
    process.exit(1);
  }

  // Stop the variant via daemon if running
  try {
    const client = getClient();
    await daemonFetch(
      urlOf(
        client.api.agents[":name"].stop.$url({
          param: { name: `${agentName}@${variantName}` },
        }),
      ),
      { method: "POST" },
    );
  } catch {
    // Daemon not running or variant not running — that's fine
  }

  // Remove the git worktree
  if (existsSync(variant.path)) {
    try {
      await exec("git", ["worktree", "remove", "--force", variant.path], { cwd: projectRoot });
    } catch {
      // Best effort
    }
  }

  // Delete the git branch
  try {
    await exec("git", ["branch", "-D", variant.branch], { cwd: projectRoot });
  } catch {
    // Best effort
  }

  // Remove from variants.json
  removeVariant(agentName, variantName);

  console.log(`Variant ${variantName} deleted.`);
}
