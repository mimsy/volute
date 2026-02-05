import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { exec, execInherit } from "../lib/exec.js";
import { parseArgs } from "../lib/parse-args.js";
import { resolveAgent } from "../lib/registry.js";
import { findVariant, removeVariant, validateBranchName } from "../lib/variants.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    summary: { type: "string" },
    justification: { type: "string" },
    memory: { type: "string" },
  });

  const agentName = positional[0];
  const variantName = positional[1];
  if (!agentName || !variantName) {
    console.error(
      "Usage: molt merge <agent> <variant> [--summary '...'] [--justification '...'] [--memory '...']",
    );
    process.exit(1);
  }

  const { dir: projectRoot } = resolveAgent(agentName);
  const variant = findVariant(projectRoot, variantName);

  if (!variant) {
    console.error(`Unknown variant: ${variantName}`);
    process.exit(1);
  }

  const branchErr = validateBranchName(variant.branch);
  if (branchErr) {
    console.error(branchErr);
    process.exit(1);
  }

  // Kill server if running
  if (variant.pid) {
    try {
      process.kill(variant.pid);
      console.log(`Killed server (pid ${variant.pid})`);
    } catch {
      // Already dead
    }
  }

  // Auto-commit any uncommitted changes in the variant worktree
  if (existsSync(variant.path)) {
    const status = (await exec("git", ["status", "--porcelain"], { cwd: variant.path })).trim();
    if (status) {
      console.log("Committing uncommitted changes in variant...");
      await exec("git", ["add", "-A"], { cwd: variant.path });
      await exec("git", ["commit", "-m", "Auto-commit uncommitted changes before merge"], {
        cwd: variant.path,
      });
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
  removeVariant(projectRoot, variantName);

  // Reinstall dependencies
  console.log("Reinstalling dependencies...");
  try {
    await execInherit("npm", ["install"], { cwd: projectRoot });
  } catch (e) {
    console.error("npm install failed:", e);
  }

  console.log(`Variant ${variantName} merged and cleaned up.`);

  // Write merged.json for post-restart orientation
  const moltDir = resolve(projectRoot, ".molt");
  if (!existsSync(moltDir)) mkdirSync(moltDir, { recursive: true });
  writeFileSync(
    resolve(moltDir, "merged.json"),
    JSON.stringify({
      name: variantName,
      ...(flags.summary && { summary: flags.summary }),
      ...(flags.justification && { justification: flags.justification }),
      ...(flags.memory && { memory: flags.memory }),
    }),
  );

  // If running under supervisor, it handles restart — just exit
  if (process.env.MOLT_SUPERVISOR) return;

  // Kill old supervisor if running
  const pidPath = resolve(moltDir, "supervisor.pid");
  if (existsSync(pidPath)) {
    try {
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      process.kill(pid);
      console.log(`Killed old supervisor (pid ${pid})`);
    } catch {
      // Already dead or invalid
    }
  }

  // Restart supervisor
  const tsxBin = resolve(projectRoot, "node_modules", ".bin", "tsx");

  // Find the supervisor module
  let supervisorModule = "";
  let searchDir = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(searchDir, "src", "lib", "supervisor.ts");
    if (existsSync(candidate)) {
      supervisorModule = candidate;
      break;
    }
    searchDir = dirname(searchDir);
  }
  if (!supervisorModule) {
    supervisorModule = resolve(
      dirname(new URL(import.meta.url).pathname),
      "..",
      "lib",
      "supervisor.ts",
    );
  }

  const { entry } = resolveAgent(agentName);

  console.log("Starting new supervisor...");
  const logsDir = resolve(projectRoot, ".molt", "logs");
  mkdirSync(logsDir, { recursive: true });
  const logFd = openSync(resolve(logsDir, "supervisor.log"), "a");

  const bootstrapCode = `
    import { runSupervisor } from ${JSON.stringify(supervisorModule)};
    runSupervisor({
      agentName: ${JSON.stringify(agentName)},
      agentDir: ${JSON.stringify(projectRoot)},
      port: ${entry.port},
    });
  `;

  const child = spawn(tsxBin, ["--eval", bootstrapCode], {
    cwd: projectRoot,
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
  child.unref();
  console.log(`Supervisor started (pid ${child.pid})`);
}
