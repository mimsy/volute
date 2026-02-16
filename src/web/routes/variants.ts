import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { getAgentManager } from "../../lib/agent-manager.js";
import { exec } from "../../lib/exec.js";
import { agentDir, findAgent, nextPort } from "../../lib/registry.js";
import { spawnServer } from "../../lib/spawn-server.js";
import {
  addVariant,
  checkHealth,
  findVariant,
  readVariants,
  removeVariant,
  validateBranchName,
} from "../../lib/variants.js";
import { verify } from "../../lib/verify.js";
import { type AuthEnv, requireAdmin } from "../middleware/auth.js";

const app = new Hono<AuthEnv>()
  .get("/:name/variants", async (c) => {
    const name = c.req.param("name");
    const entry = findAgent(name);
    if (!entry) return c.json({ error: "Agent not found" }, 404);

    const variants = readVariants(name);
    const results = await Promise.all(
      variants.map(async (v) => {
        if (!v.port) return { ...v, status: "no-server" };
        const health = await checkHealth(v.port);
        return { ...v, status: health.ok ? "running" : "dead" };
      }),
    );

    return c.json(results);
  })
  // Create variant — admin only
  .post("/:name/variants", requireAdmin, async (c) => {
    const agentName = c.req.param("name");
    const entry = findAgent(agentName);
    if (!entry) return c.json({ error: "Agent not found" }, 404);

    let body: { name: string; soul?: string; port?: number; noStart?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const variantName = body.name;
    if (!variantName) return c.json({ error: "Variant name required" }, 400);

    const err = validateBranchName(variantName);
    if (err) return c.json({ error: err }, 400);

    const projectRoot = agentDir(agentName);
    const variantDir = resolve(projectRoot, ".variants", variantName);

    if (existsSync(variantDir)) {
      return c.json({ error: `Variant directory already exists: ${variantDir}` }, 409);
    }

    mkdirSync(resolve(projectRoot, ".variants"), { recursive: true });

    // Create git worktree
    try {
      await exec("git", ["worktree", "add", "-b", variantName, variantDir], { cwd: projectRoot });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `Failed to create worktree: ${msg}` }, 500);
    }

    // Install dependencies
    try {
      await exec("npm", ["install"], { cwd: variantDir });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `npm install failed: ${msg}` }, 500);
    }

    // Write SOUL.md if provided
    if (body.soul) {
      writeFileSync(resolve(variantDir, "home/SOUL.md"), body.soul);
    }

    const variantPort = body.port ?? nextPort();

    const variant = {
      name: variantName,
      branch: variantName,
      path: variantDir,
      port: variantPort,
      created: new Date().toISOString(),
    };

    addVariant(agentName, variant);

    // Start variant via agent manager unless noStart
    if (!body.noStart) {
      try {
        await getAgentManager().startAgent(`${agentName}@${variantName}`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return c.json({ error: `Variant created but failed to start: ${msg}` }, 500);
      }
    }

    return c.json({
      ok: true,
      variant: { name: variantName, branch: variantName, path: variantDir, port: variantPort },
    });
  })
  // Merge variant — admin only
  .post("/:name/variants/:variant/merge", requireAdmin, async (c) => {
    const agentName = c.req.param("name");
    const variantName = c.req.param("variant");

    const entry = findAgent(agentName);
    if (!entry) return c.json({ error: "Agent not found" }, 404);

    const variant = findVariant(agentName, variantName);
    if (!variant) return c.json({ error: `Unknown variant: ${variantName}` }, 404);

    const branchErr = validateBranchName(variant.branch);
    if (branchErr) return c.json({ error: branchErr }, 400);

    let body: { summary?: string; justification?: string; memory?: string; skipVerify?: boolean } =
      {};
    try {
      body = await c.req.json();
    } catch {
      // No body is fine — all fields optional
    }

    const projectRoot = agentDir(agentName);

    // Auto-commit any uncommitted changes in the variant worktree
    if (existsSync(variant.path)) {
      const status = (await exec("git", ["status", "--porcelain"], { cwd: variant.path })).trim();
      if (status) {
        try {
          await exec("git", ["add", "-A"], { cwd: variant.path });
          await exec("git", ["commit", "-m", "Auto-commit uncommitted changes before merge"], {
            cwd: variant.path,
          });
        } catch (e) {
          return c.json(
            {
              error:
                "Failed to auto-commit variant changes. Commit or stash manually before merging.",
            },
            500,
          );
        }
      }
    }

    // Verify variant before merge
    if (!body.skipVerify) {
      const result = await spawnServer(variant.path, 0, { detached: true });
      if (!result) {
        return c.json(
          { error: "Failed to start server for verification. Use skipVerify to skip." },
          500,
        );
      }

      const verified = await verify(result.actualPort);

      try {
        process.kill(result.child.pid!);
      } catch {}

      if (!verified) {
        return c.json(
          { error: "Verification failed. Fix issues or use skipVerify to proceed." },
          500,
        );
      }
    }

    // Auto-commit any uncommitted changes in the main worktree
    const mainStatus = (await exec("git", ["status", "--porcelain"], { cwd: projectRoot })).trim();
    if (mainStatus) {
      try {
        await exec("git", ["add", "-A"], { cwd: projectRoot });
        await exec("git", ["commit", "-m", "Auto-commit uncommitted changes before merge"], {
          cwd: projectRoot,
        });
      } catch (e) {
        return c.json(
          { error: "Failed to auto-commit main changes. Commit or stash manually before merging." },
          500,
        );
      }
    }

    // Merge branch
    try {
      await exec("git", ["merge", variant.branch], { cwd: projectRoot });
    } catch (e) {
      return c.json({ error: "Merge failed. Resolve conflicts manually." }, 500);
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
    try {
      await exec("npm", ["install"], { cwd: projectRoot });
    } catch {
      // Best effort — agent restart will still be attempted
    }

    // Restart agent via agent manager with merge context
    const manager = getAgentManager();
    const context = {
      type: "merged",
      name: variantName,
      ...(body.summary && { summary: body.summary }),
      ...(body.justification && { justification: body.justification }),
      ...(body.memory && { memory: body.memory }),
    };

    let restartWarning: string | undefined;
    try {
      if (manager.isRunning(agentName)) {
        await manager.stopAgent(agentName);
      }
      manager.setPendingContext(agentName, context);
      await manager.startAgent(agentName);
    } catch (e) {
      restartWarning = `Merge succeeded but agent restart failed: ${e instanceof Error ? e.message : String(e)}`;
      console.error(`[daemon] ${restartWarning}`);
    }

    return c.json({ ok: true, ...(restartWarning && { warning: restartWarning }) });
  })
  // Delete variant — admin only
  .delete("/:name/variants/:variant", requireAdmin, async (c) => {
    const agentName = c.req.param("name");
    const variantName = c.req.param("variant");

    const entry = findAgent(agentName);
    if (!entry) return c.json({ error: "Agent not found" }, 404);

    const variant = findVariant(agentName, variantName);
    if (!variant) return c.json({ error: `Unknown variant: ${variantName}` }, 404);

    const projectRoot = agentDir(agentName);
    const manager = getAgentManager();
    const compositeKey = `${agentName}@${variantName}`;

    // Stop the variant if running
    if (manager.isRunning(compositeKey)) {
      try {
        await manager.stopAgent(compositeKey);
      } catch {
        // Best effort
      }
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

    return c.json({ ok: true });
  });

export default app;
