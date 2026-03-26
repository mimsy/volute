import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { getMindManager } from "../../lib/daemon/mind-manager.js";
import { chownMindDir, isIsolationEnabled, wrapForIsolation } from "../../lib/mind/isolation.js";
import {
  addVariant,
  findMind,
  findVariants,
  mindDir,
  nextPort,
  setMindRunning,
} from "../../lib/mind/registry.js";
import { spawnServer } from "../../lib/mind/spawn-server.js";
import { cleanupVariant } from "../../lib/mind/variant-cleanup.js";
import { validateBranchName } from "../../lib/mind/variants.js";
import { verify } from "../../lib/mind/verify.js";
import { exec, gitExec } from "../../lib/util/exec.js";
import { checkHealth } from "../../lib/util/health.js";
import log from "../../lib/util/logger.js";
import { type AuthEnv, requireSelf } from "../middleware/auth.js";

const app = new Hono<AuthEnv>()
  .get("/:name/variants", async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const variants = await findVariants(name);
    const results = await Promise.all(
      variants.map(async (s) => {
        if (!s.port) return { ...s, status: "no-server" };
        const health = await checkHealth(s.port);
        return { ...s, status: health.ok ? "running" : "dead" };
      }),
    );

    // Sync running status back to DB (best-effort)
    try {
      for (const r of results) {
        const isRunning = r.status === "running";
        const variant = variants.find((s) => s.name === r.name);
        if (variant && variant.running !== isRunning) {
          await setMindRunning(r.name, isRunning);
        }
      }
    } catch (err) {
      log.warn(`failed to sync variant status for ${name}`, log.errorData(err));
    }

    return c.json(results);
  })
  // Create variant — admin only
  .post("/:name/variants", requireSelf(), async (c) => {
    const mindName = c.req.param("name");
    const entry = await findMind(mindName);
    if (!entry) return c.json({ error: "Mind not found" }, 404);
    if (entry.stage === "seed")
      return c.json({ error: "Seed minds cannot create variants — sprout first" }, 403);

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

    // Check name isn't already taken
    if (await findMind(variantName)) {
      return c.json({ error: `Name already in use: ${variantName}` }, 409);
    }

    const projectRoot = mindDir(mindName);
    const variantDir = resolve(projectRoot, ".variants", variantName);

    if (existsSync(variantDir)) {
      return c.json({ error: `Variant directory already exists: ${variantDir}` }, 409);
    }

    mkdirSync(resolve(projectRoot, ".variants"), { recursive: true });

    // Create git worktree
    try {
      await gitExec(["worktree", "add", "-b", variantName, variantDir], { cwd: projectRoot });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `Failed to create worktree: ${msg}` }, 500);
    }

    // Fix ownership before npm install so it runs as the mind user
    chownMindDir(projectRoot, mindName);

    // Install dependencies
    try {
      if (isIsolationEnabled()) {
        const [cmd, args] = await wrapForIsolation("npm", ["install"], mindName);
        await exec(cmd, args, {
          cwd: variantDir,
          env: { ...process.env, HOME: resolve(variantDir, "home") },
        });
      } else {
        await exec("npm", ["install"], { cwd: variantDir });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `npm install failed: ${msg}` }, 500);
    }

    // Write SOUL.md if provided
    if (body.soul) {
      writeFileSync(resolve(variantDir, "home/SOUL.md"), body.soul);
    }

    const variantPort = body.port ?? (await nextPort());

    // Register variant in DB
    await addVariant(variantName, mindName, variantPort, variantDir, variantName);

    // Start variant via mind manager unless noStart
    if (!body.noStart) {
      try {
        await getMindManager().startMind(variantName);
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
  .post("/:name/variants/:variant/merge", requireSelf(), async (c) => {
    const mindName = c.req.param("name");
    const variantName = c.req.param("variant");

    const parentEntry = await findMind(mindName);
    if (!parentEntry) return c.json({ error: "Mind not found" }, 404);

    const variantEntry = await findMind(variantName);
    if (!variantEntry || variantEntry.parent !== mindName) {
      return c.json({ error: `Unknown variant: ${variantName}` }, 404);
    }

    if (!variantEntry.dir) return c.json({ error: `Variant ${variantName} has no directory` }, 500);
    if (!variantEntry.branch) return c.json({ error: `Variant ${variantName} has no branch` }, 500);

    const branchErr = validateBranchName(variantEntry.branch);
    if (branchErr) return c.json({ error: branchErr }, 400);

    let body: { summary?: string; justification?: string; memory?: string; skipVerify?: boolean } =
      {};
    try {
      body = await c.req.json();
    } catch {
      // No body is fine — all fields optional
    }

    const projectRoot = mindDir(mindName);

    // Auto-commit any uncommitted changes in the variant worktree
    if (existsSync(variantEntry.dir)) {
      const status = (await gitExec(["status", "--porcelain"], { cwd: variantEntry.dir })).trim();
      if (status) {
        try {
          await gitExec(["add", "-A"], { cwd: variantEntry.dir });
          await gitExec(["commit", "-m", "Auto-commit uncommitted changes before merge"], {
            cwd: variantEntry.dir,
          });
        } catch (_e) {
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
      const result = await spawnServer(variantEntry.dir, 0, { detached: true });
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
    const mainStatus = (await gitExec(["status", "--porcelain"], { cwd: projectRoot })).trim();
    if (mainStatus) {
      try {
        await gitExec(["add", "-A"], { cwd: projectRoot });
        await gitExec(["commit", "-m", "Auto-commit uncommitted changes before merge"], {
          cwd: projectRoot,
        });
      } catch (_e) {
        return c.json(
          { error: "Failed to auto-commit main changes. Commit or stash manually before merging." },
          500,
        );
      }
    }

    // Merge branch
    try {
      await gitExec(["merge", variantEntry.branch], { cwd: projectRoot });
    } catch (_e) {
      return c.json({ error: "Merge failed. Resolve conflicts manually." }, 500);
    }

    await cleanupVariant(variantName, projectRoot, variantEntry.dir);

    // Update template hash after upgrade merge
    if (variantName.endsWith("-upgrade") || variantName === "upgrade") {
      try {
        const { computeTemplateHash } = await import("../../lib/template/template-hash.js");
        const { setMindTemplateHash } = await import("../../lib/mind/registry.js");
        const tmpl = parentEntry.template ?? "claude";
        await setMindTemplateHash(mindName, computeTemplateHash(tmpl));
      } catch (err) {
        log.warn(`failed to update template hash for ${mindName}`, log.errorData(err));
      }
    }

    // Reinstall dependencies
    let restartWarning: string | undefined;
    try {
      if (isIsolationEnabled()) {
        const [cmd, args] = await wrapForIsolation("npm", ["install"], mindName);
        await exec(cmd, args, {
          cwd: projectRoot,
          env: { ...process.env, HOME: resolve(projectRoot, "home") },
        });
      } else {
        await exec("npm", ["install"], { cwd: projectRoot });
      }
    } catch (err) {
      log.warn(`npm install failed after merge for ${mindName}`, log.errorData(err));
      restartWarning = `npm install failed after merge — mind may have stale dependencies`;
    }

    // Restart mind via mind manager with merge context
    const manager = getMindManager();
    const context = {
      type: "merged",
      name: variantName,
      ...(body.summary && { summary: body.summary }),
      ...(body.justification && { justification: body.justification }),
      ...(body.memory && { memory: body.memory }),
    };

    try {
      if (manager.isRunning(mindName)) {
        await manager.stopMind(mindName);
      }
      manager.setPendingContext(mindName, context);
      await manager.startMind(mindName);
    } catch (e) {
      restartWarning = `Merge succeeded but mind restart failed: ${e instanceof Error ? e.message : String(e)}`;
      log.warn(restartWarning);
    }

    return c.json({ ok: true, ...(restartWarning && { warning: restartWarning }) });
  })
  // Delete variant — admin only
  .delete("/:name/variants/:variant", requireSelf(), async (c) => {
    const mindName = c.req.param("name");
    const variantName = c.req.param("variant");

    const parentEntry = await findMind(mindName);
    if (!parentEntry) return c.json({ error: "Mind not found" }, 404);

    const variantEntry = await findMind(variantName);
    if (!variantEntry || variantEntry.parent !== mindName) {
      return c.json({ error: `Unknown variant: ${variantName}` }, 404);
    }

    if (!variantEntry.dir) return c.json({ error: `Variant ${variantName} has no directory` }, 500);

    const projectRoot = mindDir(mindName);

    await cleanupVariant(variantName, projectRoot, variantEntry.dir, { stop: true });

    return c.json({ ok: true });
  });

export default app;
