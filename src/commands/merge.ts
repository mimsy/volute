import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { exec, execInherit } from "../lib/exec.js";
import { parseArgs } from "../lib/parse-args.js";
import { resolveAgent } from "../lib/registry.js";
import { spawnServer } from "../lib/spawn-server.js";
import { findVariant, removeVariant, validateBranchName } from "../lib/variants.js";
import { verify } from "../lib/verify.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    summary: { type: "string" },
    justification: { type: "string" },
    memory: { type: "string" },
    "skip-verify": { type: "boolean" },
  });

  const agentName = positional[0];
  const variantName = positional[1];
  if (!agentName || !variantName) {
    console.error(
      "Usage: volute merge <agent> <variant> [--summary '...'] [--justification '...'] [--memory '...'] [--skip-verify]",
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

  // Verify variant before merge
  if (!flags["skip-verify"]) {
    console.log("Verifying variant...");

    let port = variant.port;
    let tempServerPid: number | undefined;

    // Check if variant server is running
    let running = false;
    if (variant.pid) {
      try {
        process.kill(variant.pid, 0);
        running = true;
      } catch {
        // not running
      }
    }

    // Start temp server if needed
    if (!running) {
      console.log("Starting temporary server for verification...");
      const result = await spawnServer(variant.path, 0, { detached: true });
      if (!result) {
        console.error("Failed to start server for verification. Use --skip-verify to skip.");
        process.exit(1);
      }
      port = result.actualPort;
      tempServerPid = result.child.pid!;
    }

    const verified = await verify(port);

    // Kill temp server if we started one
    if (tempServerPid) {
      try {
        process.kill(tempServerPid);
      } catch {}
    }

    if (!verified) {
      console.error("Verification failed. Fix issues or use --skip-verify to proceed anyway.");
      process.exit(1);
    }

    console.log("Verification passed.");
  }

  // Kill variant server if running
  if (variant.pid) {
    try {
      process.kill(variant.pid);
      console.log(`Killed server (pid ${variant.pid})`);
    } catch {
      // Already dead
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
  const voluteDir = resolve(projectRoot, ".volute");
  if (!existsSync(voluteDir)) mkdirSync(voluteDir, { recursive: true });
  writeFileSync(
    resolve(voluteDir, "merged.json"),
    JSON.stringify({
      name: variantName,
      ...(flags.summary && { summary: flags.summary }),
      ...(flags.justification && { justification: flags.justification }),
      ...(flags.memory && { memory: flags.memory }),
    }),
  );

  // If running under supervisor, it handles restart — just exit
  if (process.env.VOLUTE_SUPERVISOR) return;

  // Kill old supervisor if running
  const pidPath = resolve(voluteDir, "supervisor.pid");
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
  const logsDir = resolve(projectRoot, ".volute", "logs");
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
