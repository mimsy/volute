import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { getOrCreateMindUser } from "../../lib/auth.js";
import { deliverEvent } from "../../lib/chat/system-events.js";
import { getMindManager, tryGetMindManager } from "../../lib/daemon/mind-manager.js";
import { createConversation, findDMConversation } from "../../lib/events/conversations.js";
import { runFarewellTurn } from "../../lib/mind/farewell.js";
import { chownMindDir } from "../../lib/mind/isolation.js";
import { createVariant, mergeVariant } from "../../lib/mind/lifecycle.js";
import { findMind, findVariants, mindDir, setMindRunning } from "../../lib/mind/registry.js";
import { cleanupVariant } from "../../lib/mind/variant-cleanup.js";
import { validateBranchName } from "../../lib/mind/variants.js";
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
  await deliverEvent(parent, {
    type: "lifecycle",
    meta: { subtype: "variant-created", variant },
    body:
      `You've split off a variant, ${variant} — a parallel version of you exploring on its own.${purposeLine} ` +
      `Reach it at @${variant} to check in on how the experiment is going, and merge its work back with ` +
      `\`volute mind join ${variant}\` when you're ready.`,
  });
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
  .post(
    "/:name/variants",
    requireSelf(),
    zValidator(
      "json",
      z.object({
        name: z.string().min(1),
        soul: z.string().optional(),
        port: z.number().optional(),
        noStart: z.boolean().optional(),
        purpose: z.string().optional(),
      }),
    ),
    async (c) => {
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

      const body = c.req.valid("json");
      const variantName = body.name;
      const purpose = body.purpose?.trim() || undefined;

      const err = validateBranchName(variantName);
      if (err) return c.json({ error: err }, 400);

      // Check name isn't already taken
      if (await findMind(variantName)) {
        return c.json({ error: `Name already in use: ${variantName}` }, 409);
      }

      const projectRoot = entry.dir ?? mindDir(mindName);

      const result = await createVariant({
        parentName: mindName,
        projectRoot,
        variantName,
        soul: body.soul,
        port: body.port,
        noStart: body.noStart,
        purpose,
      });
      if (!result.ok) return c.json({ error: result.error }, result.status);

      // The split has now cleared every rollback point. Establish the parent↔variant
      // relationship as a conversation: open a DM the two can talk in during the
      // variant's life, and tell the parent it has a variant to check in on. Placed
      // after the last rollback so a failed split never strands a DM or a stale notice.
      // Best-effort, but logged at error level — a silent failure means the dialogue
      // this feature exists for never happens.
      await establishVariantDialogue(mindName, variantName, purpose).catch((e: unknown) =>
        log.error(`failed to establish variant dialogue for ${variantName}`, log.errorData(e)),
      );

      return c.json({ ok: true, variant: result.variant });
    },
  )
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

    let body: {
      summary?: string;
      justification?: string;
      memory?: string;
      skipVerify?: boolean;
      discardUnresolved?: boolean;
    } = {};
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
    const failAfterGitWrite = async (
      message: string,
      extra?: Record<string, unknown>,
      status: 409 | 500 = 500,
    ) => {
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
      return c.json({ error: message, ...extra }, status);
    };

    // Give the variant one final turn to wind down before it's merged and
    // destroyed. Runs before the first git write below (the variant auto-commit)
    // so any home/ files it edits as it says goodbye are captured in the merge.
    // Bounded internally — a hung variant can't block the join. Wrapped so the
    // farewell can never fail the join: winding down is a courtesy, losing the
    // merge is not. The parting note (if any) is folded into the merge context
    // the parent receives below.
    let farewell: string | undefined;
    try {
      farewell = await runFarewellTurn({
        variantName,
        parentName: mindName,
        variantDir: variantEntry.dir,
        running: tryGetMindManager()?.isRunning(variantName) ?? false,
      });
    } catch (err) {
      log.warn(`farewell turn failed for ${variantName}`, log.errorData(err));
    }

    // From the first git write below through the restart, wrap everything in one
    // try/catch. The named early returns already route through failAfterGitWrite,
    // but an *uncaught* throw past the first write — spawnServer's isolation wrap,
    // an unguarded status read, verify — would otherwise 500 without restoring
    // ownership, leaving the parent (and the nested variant tree) root-owned under
    // isolation. The catch funnels those through the same restore path.
    try {
      // Fall back to the purpose captured at split so the parent's merge message can
      // recall why the variant existed even when no justification is passed at join.
      // Normalize like the split path so an explicit "" (or whitespace) still falls back.
      const justification = body.justification?.trim() || variantEntry.purpose;

      const merge = await mergeVariant({
        parentName: mindName,
        variantName,
        projectRoot,
        variantDir: variantEntry.dir,
        variantBranch: variantEntry.branch,
        verify: !body.skipVerify,
        discardUnresolved: body.discardUnresolved === true,
        variantTemplate: variantEntry.template ?? undefined,
        parentTemplate: parentEntry.template ?? undefined,
        contextExtras: { summary: body.summary, justification, memory: body.memory, farewell },
      });

      switch (merge.status) {
        case "autocommit_failed":
        case "verify_failed":
        case "check_failed":
          return failAfterGitWrite(merge.message);
        case "conflict":
          return failAfterGitWrite(merge.message, { conflicts: merge.conflicts });
        case "unresolved":
          return failAfterGitWrite(
            merge.message,
            {
              unresolvedFiles: merge.unresolved.files,
              unresolvedCount: merge.unresolved.totalCount,
              unresolvedBytes: merge.unresolved.totalBytes,
            },
            409,
          );
      }

      // Restart the parent with the merge context. A failed restart (or a stale-deps
      // npm warning surfaced by mergeVariant) is a warning, not a failure — the merge
      // and cleanup already landed.
      let restartWarning = merge.warning;
      const manager = getMindManager();
      try {
        if (manager.isRunning(mindName)) {
          await manager.stopMind(mindName);
        }
        manager.setPendingContext(mindName, merge.context);
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

    await cleanupVariant(variantName, mindName, projectRoot, variantEntry.dir, { stop: true });

    return c.json({ ok: true });
  });

export default app;
