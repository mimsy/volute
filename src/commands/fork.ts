import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { daemonFetch } from "../lib/daemon-client.js";
import { exec, execInherit } from "../lib/exec.js";
import { parseArgs } from "../lib/parse-args.js";
import { nextPort, resolveAgent } from "../lib/registry.js";
import { addVariant, validateBranchName } from "../lib/variants.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    soul: { type: "string" },
    port: { type: "number" },
    "no-start": { type: "boolean" },
    json: { type: "boolean" },
  });

  const agentName = positional[0];
  const variantName = positional[1];
  const { soul, port, json } = flags;
  const noStart = flags["no-start"];

  if (!agentName || !variantName) {
    console.error(
      'Usage: volute fork <agent> <variant> [--soul "..."] [--port N] [--no-start] [--json]',
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

  const parentDir = resolve(projectRoot, ".variants");
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

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
    pid: null,
    created: new Date().toISOString(),
  };

  addVariant(agentName, variant);

  if (!noStart) {
    if (!json) console.log("Starting variant via daemon...");
    try {
      const res = await daemonFetch(
        `/api/agents/${encodeURIComponent(`${agentName}@${variantName}`)}/start`,
        {
          method: "POST",
        },
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
