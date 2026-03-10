import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { getMindManager } from "../../lib/daemon/mind-manager.js";
import { exec, gitExec } from "../../lib/exec.js";
import { chownMindDir, isIsolationEnabled, wrapForIsolation } from "../../lib/isolation.js";
import log from "../../lib/logger.js";
import {
  addSplit,
  findMind,
  findSplits,
  mindDir,
  nextPort,
  removeMind,
  setMindRunning,
} from "../../lib/registry.js";
import { spawnServer } from "../../lib/spawn-server.js";
import { cleanupSplit } from "../../lib/split-cleanup.js";
import { validateBranchName } from "../../lib/variants.js";
import { verify } from "../../lib/verify.js";
import { type AuthEnv, requireAdmin } from "../middleware/auth.js";

async function checkHealth(port: number): Promise<{ ok: boolean; name?: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return { ok: false };
    const data = (await res.json()) as { name: string };
    return { ok: true, name: data.name };
  } catch {
    return { ok: false };
  }
}

const app = new Hono<AuthEnv>()
  .get("/:name/variants", async (c) => {
    const name = c.req.param("name");
    const entry = findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const splits = findSplits(name);
    const results = await Promise.all(
      splits.map(async (s) => {
        if (!s.port) return { ...s, status: "no-server" };
        const health = await checkHealth(s.port);
        return { ...s, status: health.ok ? "running" : "dead" };
      }),
    );

    // Sync running status back to DB (best-effort)
    try {
      for (const r of results) {
        const isRunning = r.status === "running";
        const split = splits.find((s) => s.name === r.name);
        if (split && split.running !== isRunning) {
          setMindRunning(r.name, isRunning);
        }
      }
    } catch (err) {
      log.warn(`failed to sync split status for ${name}`, log.errorData(err));
    }

    return c.json(results);
  })
  // Create variant — admin only
  .post("/:name/variants", requireAdmin, async (c) => {
    const mindName = c.req.param("name");
    const entry = findMind(mindName);
    if (!entry) return c.json({ error: "Mind not found" }, 404);
    if (entry.stage === "seed")
      return c.json({ error: "Seed minds cannot create variants — sprout first" }, 403);

    let body: { name: string; soul?: string; port?: number; noStart?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const splitName = body.name;
    if (!splitName) return c.json({ error: "Split name required" }, 400);

    const err = validateBranchName(splitName);
    if (err) return c.json({ error: err }, 400);

    // Check name isn't already taken
    if (findMind(splitName)) {
      return c.json({ error: `Name already in use: ${splitName}` }, 409);
    }

    const projectRoot = mindDir(mindName);
    const splitDir = resolve(projectRoot, ".variants", splitName);

    if (existsSync(splitDir)) {
      return c.json({ error: `Split directory already exists: ${splitDir}` }, 409);
    }

    mkdirSync(resolve(projectRoot, ".variants"), { recursive: true });

    // Create git worktree
    try {
      await gitExec(["worktree", "add", "-b", splitName, splitDir], { cwd: projectRoot });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `Failed to create worktree: ${msg}` }, 500);
    }

    // Fix ownership before npm install so it runs as the mind user
    chownMindDir(projectRoot, mindName);

    // Install dependencies
    try {
      if (isIsolationEnabled()) {
        const [cmd, args] = wrapForIsolation("npm", ["install"], mindName);
        await exec(cmd, args, {
          cwd: splitDir,
          env: { ...process.env, HOME: resolve(splitDir, "home") },
        });
      } else {
        await exec("npm", ["install"], { cwd: splitDir });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `npm install failed: ${msg}` }, 500);
    }

    // Write SOUL.md if provided
    if (body.soul) {
      writeFileSync(resolve(splitDir, "home/SOUL.md"), body.soul);
    }

    const splitPort = body.port ?? nextPort();

    // Register split in DB
    addSplit(splitName, mindName, splitPort, splitDir, splitName);

    // Start split via mind manager unless noStart
    if (!body.noStart) {
      try {
        await getMindManager().startMind(splitName);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return c.json({ error: `Split created but failed to start: ${msg}` }, 500);
      }
    }

    return c.json({
      ok: true,
      variant: { name: splitName, branch: splitName, path: splitDir, port: splitPort },
    });
  })
  // Merge variant — admin only
  .post("/:name/variants/:variant/merge", requireAdmin, async (c) => {
    const mindName = c.req.param("name");
    const splitName = c.req.param("variant");

    const parentEntry = findMind(mindName);
    if (!parentEntry) return c.json({ error: "Mind not found" }, 404);

    const splitEntry = findMind(splitName);
    if (!splitEntry || splitEntry.parent !== mindName) {
      return c.json({ error: `Unknown split: ${splitName}` }, 404);
    }

    if (!splitEntry.dir) return c.json({ error: `Split ${splitName} has no directory` }, 500);
    if (!splitEntry.branch) return c.json({ error: `Split ${splitName} has no branch` }, 500);

    const branchErr = validateBranchName(splitEntry.branch);
    if (branchErr) return c.json({ error: branchErr }, 400);

    let body: { summary?: string; justification?: string; memory?: string; skipVerify?: boolean } =
      {};
    try {
      body = await c.req.json();
    } catch {
      // No body is fine — all fields optional
    }

    const projectRoot = mindDir(mindName);

    // Auto-commit any uncommitted changes in the split worktree
    if (existsSync(splitEntry.dir)) {
      const status = (await gitExec(["status", "--porcelain"], { cwd: splitEntry.dir })).trim();
      if (status) {
        try {
          await gitExec(["add", "-A"], { cwd: splitEntry.dir });
          await gitExec(["commit", "-m", "Auto-commit uncommitted changes before merge"], {
            cwd: splitEntry.dir,
          });
        } catch (e) {
          return c.json(
            {
              error:
                "Failed to auto-commit split changes. Commit or stash manually before merging.",
            },
            500,
          );
        }
      }
    }

    // Verify split before merge
    if (!body.skipVerify) {
      const result = await spawnServer(splitEntry.dir, 0, { detached: true });
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
      } catch (e) {
        return c.json(
          { error: "Failed to auto-commit main changes. Commit or stash manually before merging." },
          500,
        );
      }
    }

    // Merge branch
    try {
      await gitExec(["merge", splitEntry.branch], { cwd: projectRoot });
    } catch (e) {
      return c.json({ error: "Merge failed. Resolve conflicts manually." }, 500);
    }

    await cleanupSplit(splitName, projectRoot, splitEntry.dir);

    // Update template hash after upgrade merge
    if (splitName.endsWith("-upgrade") || splitName === "upgrade") {
      try {
        const { computeTemplateHash } = await import("../../lib/template-hash.js");
        const { setMindTemplateHash } = await import("../../lib/registry.js");
        const tmpl = parentEntry.template ?? "claude";
        setMindTemplateHash(mindName, computeTemplateHash(tmpl));
      } catch (err) {
        console.error(`[daemon] failed to update template hash for ${mindName}:`, err);
      }
    }

    // Reinstall dependencies
    try {
      if (isIsolationEnabled()) {
        const [cmd, args] = wrapForIsolation("npm", ["install"], mindName);
        await exec(cmd, args, {
          cwd: projectRoot,
          env: { ...process.env, HOME: resolve(projectRoot, "home") },
        });
      } else {
        await exec("npm", ["install"], { cwd: projectRoot });
      }
    } catch {
      // Best effort — mind restart will still be attempted
    }

    // Restart mind via mind manager with merge context
    const manager = getMindManager();
    const context = {
      type: "merged",
      name: splitName,
      ...(body.summary && { summary: body.summary }),
      ...(body.justification && { justification: body.justification }),
      ...(body.memory && { memory: body.memory }),
    };

    let restartWarning: string | undefined;
    try {
      if (manager.isRunning(mindName)) {
        await manager.stopMind(mindName);
      }
      manager.setPendingContext(mindName, context);
      await manager.startMind(mindName);
    } catch (e) {
      restartWarning = `Merge succeeded but mind restart failed: ${e instanceof Error ? e.message : String(e)}`;
      console.error(`[daemon] ${restartWarning}`);
    }

    return c.json({ ok: true, ...(restartWarning && { warning: restartWarning }) });
  })
  // Delete variant — admin only
  .delete("/:name/variants/:variant", requireAdmin, async (c) => {
    const mindName = c.req.param("name");
    const splitName = c.req.param("variant");

    const parentEntry = findMind(mindName);
    if (!parentEntry) return c.json({ error: "Mind not found" }, 404);

    const splitEntry = findMind(splitName);
    if (!splitEntry || splitEntry.parent !== mindName) {
      return c.json({ error: `Unknown split: ${splitName}` }, 404);
    }

    if (!splitEntry.dir) return c.json({ error: `Split ${splitName} has no directory` }, 500);

    const projectRoot = mindDir(mindName);

    await cleanupSplit(splitName, projectRoot, splitEntry.dir, { stop: true });

    return c.json({ ok: true });
  });

export default app;
