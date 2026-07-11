import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { getOrCreateMindUser } from "../../lib/auth.js";
import { sendSystemMessage } from "../../lib/chat/system-chat.js";
import { getMindManager } from "../../lib/daemon/mind-manager.js";
import { createConversation, findDMConversation } from "../../lib/events/conversations.js";
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
import {
  mergeVariantExcludingMemory,
  VariantMergeError,
  validateBranchName,
} from "../../lib/mind/variants.js";
import { verify } from "../../lib/mind/verify.js";
import { exec, gitExec } from "../../lib/util/exec.js";
import { checkHealth } from "../../lib/util/health.js";
import log from "../../lib/util/logger.js";
import { type AuthEnv, requireSelf } from "../middleware/auth.js";

/**
 * Establish the parent↔variant relationship as a conversation, not just plumbing:
 * open a DM between the two mind identities so they have a thread to talk in while
 * the variant lives, and notify the running parent that it now has a variant to
 * check in on (with the purpose, if one was given). The variant learns why it
 * exists from its own split birth-context message.
 */
export async function establishVariantDialogue(
  parent: string,
  variant: string,
  purpose?: string,
): Promise<void> {
  const parentUser = await getOrCreateMindUser(parent);
  const variantUser = await getOrCreateMindUser(variant);

  const existing = await findDMConversation([parentUser.id, variantUser.id]);
  if (!existing) {
    await createConversation({ participantIds: [parentUser.id, variantUser.id] });
  }

  const purposeLine = purpose ? ` Its purpose: ${purpose}.` : "";
  await sendSystemMessage(
    parent,
    `You've split off a variant, ${variant} — a parallel version of you exploring on its own.${purposeLine} ` +
      `Reach it at @${variant} to check in on how the experiment is going, and merge its work back with ` +
      `\`volute mind join ${variant}\` when you're ready.`,
  );
}

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
    if (entry.parent)
      return c.json(
        { error: "Cannot split from a variant — split from the base mind instead" },
        403,
      );

    let body: { name: string; soul?: string; port?: number; noStart?: boolean; purpose?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const variantName = body.name;
    if (!variantName) return c.json({ error: "Variant name required" }, 400);

    const purpose = body.purpose?.trim() || undefined;

    const err = validateBranchName(variantName);
    if (err) return c.json({ error: err }, 400);

    // Check name isn't already taken
    if (await findMind(variantName)) {
      return c.json({ error: `Name already in use: ${variantName}` }, 409);
    }

    const projectRoot = entry.dir ?? mindDir(mindName);
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
      // mkdirSync + `git worktree add` ran as the daemon (root) and may leave
      // root-owned files under .variants/ in the mind's tree; hand ownership
      // back before returning so the mind can retry. Surface a restore failure
      // so a left-behind-root-files condition isn't hidden.
      let error = `Failed to create worktree: ${msg}`;
      try {
        await chownMindDir(projectRoot, mindName);
      } catch (err) {
        log.warn(
          `failed to restore ownership after worktree-add failure for ${mindName}`,
          log.errorData(err),
        );
        error += ` Restoring mind ownership also failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      return c.json({ error }, 500);
    }

    // Everything after the worktree is created is rolled back on failure so a
    // retry with the same name isn't blocked by a half-created variant (#444).
    const rollbackSplit = async () => {
      try {
        await cleanupVariant(variantName, projectRoot, variantDir, { stop: true });
      } catch (err) {
        log.warn(`failed to roll back split of ${variantName}`, log.errorData(err));
      }
      // cleanupVariant hands ownership to the variant's base name, which before DB
      // registration resolves to the variant itself — restore it to the parent mind.
      try {
        await chownMindDir(projectRoot, mindName);
      } catch (err) {
        log.warn(
          `failed to restore ${mindName} ownership after split rollback`,
          log.errorData(err),
        );
      }
    };

    // Fix ownership before npm install so it runs as the mind user. This is the
    // first step past worktree creation, so a throw here (chownMindDir re-throws
    // under isolation) must also roll back or it strands the worktree+branch.
    try {
      await chownMindDir(projectRoot, mindName);
    } catch (e: unknown) {
      await rollbackSplit();
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `Failed to prepare variant ownership: ${msg}` }, 500);
    }

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
      await rollbackSplit();
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `npm install failed: ${msg}` }, 500);
    }

    // Write SOUL.md if provided
    if (body.soul) {
      writeFileSync(resolve(variantDir, "home/SOUL.md"), body.soul);
    }

    const variantPort = body.port ?? (await nextPort());

    // Register variant in DB
    try {
      await addVariant(variantName, mindName, variantPort, variantDir, variantName, purpose);
    } catch (e: unknown) {
      await rollbackSplit();
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `Failed to register variant: ${msg}` }, 500);
    }

    // Queue the variant's birth context now, independent of --no-start: it's the
    // variant's first message — who it is, where it came from, and why it was split
    // off — and deliverPendingContext fires on whatever first start happens, so a
    // variant started manually later still gets oriented. (pendingContext is an
    // in-memory map, so a daemon restart before that start drops this transient
    // orientation — acceptable; the variant just starts without the birth message.)
    const manager = getMindManager();
    manager.setPendingContext(variantName, { type: "split", parent: mindName, purpose });

    if (!body.noStart) {
      try {
        await manager.startMind(variantName);
      } catch (e: unknown) {
        await rollbackSplit();
        const msg = e instanceof Error ? e.message : String(e);
        return c.json({ error: `Variant created but failed to start: ${msg}` }, 500);
      }
    }

    // The split has now cleared every rollback point. Establish the parent↔variant
    // relationship as a conversation: open a DM the two can talk in during the
    // variant's life, and tell the parent it has a variant to check in on. Placed
    // after the last rollback so a failed split never strands a DM or a stale notice.
    // Best-effort, but logged at error level — a silent failure means the dialogue
    // this feature exists for never happens.
    await establishVariantDialogue(mindName, variantName, purpose).catch((e: unknown) =>
      log.error(`failed to establish variant dialogue for ${variantName}`, log.errorData(e)),
    );

    return c.json({
      ok: true,
      variant: {
        name: variantName,
        branch: variantName,
        path: variantDir,
        port: variantPort,
        ...(purpose && { purpose }),
      },
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

    const projectRoot = parentEntry.dir ?? mindDir(mindName);

    // Every early return past this point can follow a git write that ran as the
    // daemon (root): the variant/main auto-commits, the merge, and the merge
    // --abort. Under user isolation that leaves the parent worktree — and the
    // variant worktree nested under it at .variants/<name>, which chownMindDir
    // recurses — owned root:root, locking the still-running mind out of its own
    // files. Hand ownership back before returning; surface a restore failure,
    // since under isolation it means root-owned files were left behind.
    const failAfterGitWrite = async (message: string, extra?: Record<string, unknown>) => {
      try {
        await chownMindDir(projectRoot, mindName);
      } catch (err) {
        log.warn(
          `failed to restore ownership for ${mindName} after merge failure`,
          log.errorData(err),
        );
        return c.json(
          {
            error: `${message} Restoring mind ownership also failed: ${err instanceof Error ? err.message : String(err)}`,
            ...extra,
          },
          500,
        );
      }
      return c.json({ error: message, ...extra }, 500);
    };

    // From the first git write below through the restart, wrap everything in one
    // try/catch. The named early returns already route through failAfterGitWrite,
    // but an *uncaught* throw past the first write — spawnServer's isolation wrap,
    // an unguarded status read, verify — would otherwise 500 without restoring
    // ownership, leaving the parent (and the nested variant tree) root-owned under
    // isolation. The catch funnels those through the same restore path.
    try {
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
            return failAfterGitWrite(
              "Failed to auto-commit variant changes. Commit or stash manually before merging.",
            );
          }
        }
      }

      // Verify variant before merge
      if (!body.skipVerify) {
        const result = await spawnServer(variantEntry.dir, 0, {
          detached: true,
          mindName: variantName,
          template: variantEntry.template,
        });
        if (!result) {
          return failAfterGitWrite(
            "Failed to start server for verification. Use skipVerify to skip.",
          );
        }

        const verified = await verify(result.actualPort);

        try {
          // The verify server is detached (its own process-group leader), so kill
          // the whole group — under sandbox/isolation the real server is a wrapped
          // grandchild that a single-PID SIGTERM would leave running.
          process.kill(-result.child.pid!, "SIGTERM");
        } catch {}

        if (!verified) {
          return failAfterGitWrite("Verification failed. Fix issues or use skipVerify to proceed.");
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
          return failAfterGitWrite(
            "Failed to auto-commit main changes. Commit or stash manually before merging.",
          );
        }
      }

      // Merge the variant into the parent, excluding the mind's living memory and
      // journal — those ride to the parent as `memoryDelta` (#440) instead of
      // being line-merged. A real code/config conflict (or a failed restore)
      // aborts the merge and throws VariantMergeError; route it through
      // failAfterGitWrite so ownership is restored and the conflicts are reported.
      let memoryDelta = "";
      try {
        memoryDelta = await mergeVariantExcludingMemory(projectRoot, variantEntry.branch);
      } catch (err) {
        if (!(err instanceof VariantMergeError)) throw err;
        // Leave the variant intact so the conflict can be resolved in the variant
        // and the join retried. If the abort itself failed, the parent is left
        // mid-merge with conflict markers on disk — say so, since the still-running
        // mind could auto-commit them.
        return failAfterGitWrite(
          err.abortFailed
            ? "Merge failed and the abort did not complete — the parent worktree may be left mid-merge with conflict markers; manual cleanup may be needed."
            : "Merge failed. Resolve conflicts in the variant and retry the join.",
          { conflicts: err.conflicts },
        );
      }

      await cleanupVariant(variantName, projectRoot, variantEntry.dir, { stop: true });

      // The merge and cleanup git ops ran as the daemon (root). Hand ownership of
      // the parent worktree back to the mind user before the wrapped npm install
      // (which runs as that user) and the restart — otherwise the tree is left
      // root-owned under isolation. Mirrors the split/create path.
      await chownMindDir(projectRoot, mindName);

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
      // Fall back to the purpose captured at split so the parent's merge message can
      // recall why the variant existed even when no justification is passed at join.
      // Normalize like the split path so an explicit "" (or whitespace) still falls back.
      const justification = body.justification?.trim() || variantEntry.purpose;
      const context = {
        type: "merged",
        name: variantName,
        ...(body.summary && { summary: body.summary }),
        ...(justification && { justification }),
        ...(body.memory && { memory: body.memory }),
        ...(memoryDelta && { memoryDelta }),
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
    } catch (err) {
      // Uncaught throw past the first git write — restore ownership before the
      // generic 500 so isolation never leaves the tree root-owned. "join failed"
      // stays accurate whether the throw was pre- or post-merge.
      log.error(`variant join failed for ${mindName}`, log.errorData(err));
      return await failAfterGitWrite(
        `Variant join failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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

    const projectRoot = parentEntry.dir ?? mindDir(mindName);

    await cleanupVariant(variantName, projectRoot, variantEntry.dir, { stop: true });

    return c.json({ ok: true });
  });

export default app;
