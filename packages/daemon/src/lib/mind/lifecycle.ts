import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  isAiConfigured,
  missingCredentialWarning,
  qualifyModelId,
  resolveTemplate,
  unqualifyModelId,
} from "../ai-service.js";
import { announceToCommons } from "../chat/commons-channel.js";
import { getSpiritName } from "../config/setup.js";
import { getMindManager } from "../daemon/mind-manager.js";
import { getDb } from "../db.js";
import {
  ARCHIVE_INIT_LEDGER,
  type ExportManifest,
  isHomeOnlyArchive,
  overlayArchiveHome,
} from "../mind/archive.js";
import { TEMPLATE_BRANCH } from "../mind/upgrade.js";
import { getMindPromptDefaults, getPrompt, getPromptIfCustom, substitute } from "../prompts.js";
import { mindHistory } from "../schema.js";
import { getStandardSkillsWithExtensions, installSkill, SEED_SKILLS } from "../skills.js";
import { convertSession } from "../template/convert-session.js";
import {
  findOpenClawSession,
  importOpenClawConnectors,
  importPiSession,
  parseNameFromIdentity,
} from "../template/import-utils.js";
import {
  applyInitFiles,
  composeTemplate,
  copyTemplateToDir,
  findTemplatesRoot,
  isInitInfrastructure,
  listFiles,
  listInfrastructureOnDisk,
  type TemplateManifest,
} from "../template/template.js";
import { computeTemplateHash } from "../template/template-hash.js";
import { exec, gitExec } from "../util/exec.js";
import log from "../util/logger.js";
import { fireWebhook } from "../webhook.js";
import { consolidateMemory } from "./consolidate.js";
import { defaultHeartbeatSchedule, setupDefaultDreaming } from "./default-autonomy.js";
import { generateIdentity, publishPublicKey } from "./identity.js";
import { readInitLedgerFile, seedInitLedger } from "./init-ledger.js";
import {
  chownMindDir,
  createMindUser,
  ensureVoluteGroup,
  isIsolationEnabled,
  wrapForIsolation,
} from "./isolation.js";
import { npmInstallAsMind, npmInstallNeeded } from "./npm-install.js";
import {
  addMind,
  addVariant,
  countCappedMinds,
  ensureVoluteHome,
  findMind,
  mindDir,
  nextPort,
  removeMind,
  setMindTemplateHash,
  stateDir,
  validateMindName,
} from "./registry.js";
import { spawnServer } from "./spawn-server.js";
import { configureGitIdentity } from "./upgrade.js";
import { cleanupVariant } from "./variant-cleanup.js";
import {
  findUnresolvedHomeFiles,
  formatUnresolvedHomeFilesMessage,
  mergeVariantExcludingMemory,
  type UnresolvedHomeFiles,
  VariantMergeError,
} from "./variants.js";
import { verify } from "./verify.js";
import { readVoluteConfig, writeVoluteConfig } from "./volute-config.js";

const llog = log.child("lifecycle");

/**
 * The outcome of a lifecycle operation invoked from a thin route handler. `ok`
 * carries the success payload verbatim (the route does `c.json(body)`); the
 * failure form carries the HTTP status + error string the route maps to
 * `c.json({ error }, status)`. Keeps create/import/split logic out of the HTTP
 * layer while preserving each operation's exact response shapes (#330).
 */
export type LifecycleResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string };

/**
 * Create the volute/template tracking branch and main branch with shared history.
 * Enables clean 3-way merges on the first `volute mind upgrade`. Called during
 * mind creation and home-only archive import (both compose a fresh template).
 */
export async function initTemplateBranch(
  projectRoot: string,
  composedDir: string,
  manifest: TemplateManifest,
  mindName?: string,
  env?: NodeJS.ProcessEnv,
) {
  const templateFiles = listFiles(composedDir)
    .filter((f) => !f.startsWith(".init/") && !f.startsWith(".init\\"))
    .filter((f) => (!f.startsWith("home/") && !f.startsWith("home\\")) || f === "home/VOLUTE.md")
    .map((f) => manifest.rename[f] ?? f);

  const opts = { cwd: projectRoot, mindName, env };

  await gitExec(["checkout", "--orphan", TEMPLATE_BRANCH], opts);
  await gitExec(["add", "--", ...templateFiles], opts);
  await gitExec(["commit", "-m", "template update"], opts);

  await gitExec(["checkout", "-b", "main"], opts);
  await gitExec(["add", "-A"], opts);
  await gitExec(["commit", "-m", "initial commit"], opts);
}

/**
 * The single `type` a variant-join delivers as its post-merge continuity context.
 * (The mind-initiated restart path historically stamped `"merge"` and the merge
 * route `"merged"`; both map to the same lifecycle subtype and prompt, so the one
 * value is behavior-identical for either caller — see buildPendingContextMessage.)
 */
export type VariantMergeContextType = "merged";

/** Extra, caller-supplied fields folded into the merge continuity message. */
export interface VariantMergeContextExtras {
  summary?: string;
  justification?: string;
  memory?: string;
  farewell?: string;
}

/**
 * The outcome of {@link mergeVariant}. `merged` is the only success; the rest are
 * distinct failure modes the two call sites map to their own semantics (an HTTP
 * status for the merge route, a notice + restart-downgrade for the mind-initiated
 * restart path). The variant is left fully intact on every non-`merged` outcome —
 * cleanup runs only once the merge has landed and (unless discarded) no unresolved
 * home/ files remain — so a failed join can always be retried.
 */
export type VariantMergeResult =
  | { status: "merged"; memoryDelta: string; context: Record<string, unknown>; warning?: string }
  | { status: "autocommit_failed"; side: "variant" | "main"; message: string }
  | { status: "verify_failed"; message: string }
  | { status: "conflict"; conflicts: string[]; abortFailed: boolean; message: string }
  | { status: "unresolved"; message: string; unresolved: UnresolvedHomeFiles }
  | { status: "check_failed"; message: string };

export interface MergeVariantParams {
  /** The base mind the variant merges into (owns projectRoot). */
  parentName: string;
  variantName: string;
  projectRoot: string;
  variantDir: string;
  variantBranch: string;
  /** Spawn the variant and run its self-check before merging (merge route: !skipVerify). */
  verify: boolean;
  /** Skip the unresolved-home/-files gate and clean up regardless (join --discard). */
  discardUnresolved?: boolean;
  /** The variant's own template — used to spawn it correctly during verify. */
  variantTemplate?: string;
  /** Parent's template — used to bump the stored template hash after an upgrade-named join. */
  parentTemplate?: string;
  contextType?: VariantMergeContextType;
  contextExtras?: VariantMergeContextExtras;
}

/**
 * Merge a variant back into its parent — the single implementation behind both the
 * `POST /:name/variants/:variant/merge` route and the mind-initiated merge inside
 * the restart handler (#330 collapsed two divergent copies into this).
 *
 * The shared spine: auto-commit both worktrees → optionally verify the variant →
 * merge excluding the mind's living memory/journal (which rides back as
 * `memoryDelta`, #440) → gate on unresolved home/ files → clean up the worktree +
 * branch → reinstall deps only if the merge touched them. It never restarts the
 * parent: the two callers differ there (the merge route does its own stop/start;
 * the restart handler owns a last-known-good recovery path), so the caller sets
 * the returned `context` as pending and restarts however it must.
 *
 * All git writes run as the daemon (root); the caller is responsible for restoring
 * ownership on the failure paths it surfaces (chownMindDir), mirroring the pre-#330
 * behavior. cleanupVariant already chowns projectRoot back on the success path.
 */
export async function mergeVariant(params: MergeVariantParams): Promise<VariantMergeResult> {
  const {
    parentName,
    variantName,
    projectRoot,
    variantDir,
    variantBranch,
    discardUnresolved = false,
    contextExtras = {},
  } = params;

  // Auto-commit any uncommitted changes in the variant worktree so they ride into
  // the merge. A failure here is fatal to the join — surfacing it (rather than the
  // old restart-path behavior of swallowing it with log.error) is one of the
  // consistency wins of collapsing the two copies.
  if (existsSync(variantDir)) {
    const status = (await gitExec(["status", "--porcelain"], { cwd: variantDir })).trim();
    if (status) {
      try {
        await gitExec(["add", "-A"], { cwd: variantDir });
        await gitExec(["commit", "-m", "Auto-commit uncommitted changes before merge"], {
          cwd: variantDir,
        });
      } catch (e) {
        llog.warn(`failed to auto-commit variant worktree for ${parentName}`, log.errorData(e));
        return {
          status: "autocommit_failed",
          side: "variant",
          message:
            "Failed to auto-commit variant changes. Commit or stash manually before merging.",
        };
      }
    }
  }

  // Verify the variant boots and passes its self-check before it's merged and
  // destroyed. The server is detached (its own process-group leader), so kill the
  // whole group — under sandbox/isolation the real server is a wrapped grandchild.
  if (params.verify) {
    const result = await spawnServer(variantDir, 0, {
      detached: true,
      mindName: variantName,
      template: params.variantTemplate,
    });
    if (!result) {
      return {
        status: "verify_failed",
        message: "Failed to start server for verification. Use skipVerify to skip.",
      };
    }
    const verified = await verify(result.actualPort);
    try {
      process.kill(-result.child.pid!, "SIGTERM");
    } catch {}
    if (!verified) {
      return {
        status: "verify_failed",
        message: "Verification failed. Fix issues or use skipVerify to proceed.",
      };
    }
  }

  // Auto-commit any uncommitted changes in the main worktree before merging into it.
  const mainStatus = (await gitExec(["status", "--porcelain"], { cwd: projectRoot })).trim();
  if (mainStatus) {
    try {
      await gitExec(["add", "-A"], { cwd: projectRoot });
      await gitExec(["commit", "-m", "Auto-commit uncommitted changes before merge"], {
        cwd: projectRoot,
      });
    } catch (e) {
      llog.warn(`failed to auto-commit main worktree for ${parentName}`, log.errorData(e));
      return {
        status: "autocommit_failed",
        side: "main",
        message: "Failed to auto-commit main changes. Commit or stash manually before merging.",
      };
    }
  }

  // Merge, excluding the mind's living memory/journal — those ride back as
  // `memoryDelta` (#440). A real code/config conflict aborts the merge and throws
  // VariantMergeError; the variant is left intact so the conflict can be resolved
  // there and the join retried.
  const preMergeHead = (await gitExec(["rev-parse", "HEAD"], { cwd: projectRoot })).trim();
  let memoryDelta = "";
  try {
    memoryDelta = await mergeVariantExcludingMemory(projectRoot, variantBranch);
  } catch (err) {
    if (!(err instanceof VariantMergeError)) throw err;
    return {
      status: "conflict",
      conflicts: err.conflicts,
      abortFailed: err.abortFailed,
      message: err.abortFailed
        ? "Merge failed and the abort did not complete — the parent worktree may be left mid-merge with conflict markers; manual cleanup may be needed."
        : "Merge failed. Resolve conflicts in the variant and retry the join.",
    };
  }

  // The daemon can't know what's precious in a mind's home/ (a download, a cloned
  // repo, a venv), so it never guesses. Checked right before the one genuinely
  // destructive step (cleanupVariant's `git worktree remove`): the merge above
  // already landed (it only pulls in what the variant committed), but cleanup —
  // the point of no return — waits until this comes back clean.
  if (existsSync(variantDir) && !discardUnresolved) {
    let unresolved: UnresolvedHomeFiles;
    try {
      unresolved = await findUnresolvedHomeFiles(variantDir);
    } catch (err) {
      return {
        status: "check_failed",
        message: `Could not verify variant ${variantName} has no unresolved home/ files: ${err instanceof Error ? err.message : String(err)}. Variant left intact — retry the join.`,
      };
    }
    if (unresolved.totalCount > 0) {
      return {
        status: "unresolved",
        message: formatUnresolvedHomeFilesMessage(variantName, unresolved),
        unresolved,
      };
    }
  }

  await cleanupVariant(variantName, parentName, projectRoot, variantDir, { stop: true });

  // The merge/cleanup git ops ran as the daemon (root). Hand ownership of the
  // parent worktree back to the mind user before the wrapped npm install (which
  // runs as that user) and the caller's restart — otherwise the tree is left
  // root-owned under isolation. (cleanupVariant already chowns, but a belt-and-
  // suspenders chown here mirrors the merge route and precedes the install.)
  await chownMindDir(projectRoot, parentName);

  // Bump the stored template hash after an upgrade-named join so staleness tracking
  // stays accurate (the variant merged the newer template into the parent).
  if (variantName.endsWith("-upgrade") || variantName === "upgrade") {
    try {
      await setMindTemplateHash(parentName, computeTemplateHash(params.parentTemplate ?? "claude"));
    } catch (err) {
      llog.warn(`failed to update template hash for ${parentName}`, log.errorData(err));
    }
  }

  // Reinstall dependencies only when the merge actually touched them — a no-op
  // install still writes enough to stall slow storage for a minute.
  let warning: string | undefined;
  if (await npmInstallNeeded(projectRoot, preMergeHead)) {
    try {
      await npmInstallAsMind(projectRoot, parentName);
    } catch (err) {
      llog.warn(`npm install failed after merge for ${parentName}`, log.errorData(err));
      warning = "npm install failed after merge — mind may have stale dependencies";
    }
  }

  const context: Record<string, unknown> = {
    type: params.contextType ?? "merged",
    name: variantName,
    ...(contextExtras.summary && { summary: contextExtras.summary }),
    ...(contextExtras.justification && { justification: contextExtras.justification }),
    ...(contextExtras.memory && { memory: contextExtras.memory }),
    ...(memoryDelta && { memoryDelta }),
    ...(contextExtras.farewell && { farewell: contextExtras.farewell }),
  };

  return { status: "merged", memoryDelta, context, warning };
}

/** Input for {@link createMind} — the validated create-mind request body. */
export interface CreateMindInput {
  name: string;
  template?: string;
  stage?: "seed" | "sprouted";
  description?: string;
  model?: string;
  seedSoul?: string;
  skills?: string[];
  createdBy?: string;
}

/**
 * Create a new mind: compose the template, generate identity, apply config/skill
 * defaults, set up isolation + git + template branch, and register it. Moved out
 * of the POST `/` route body verbatim (#330); the route parses/authorizes and maps
 * the result to HTTP. `username` is the authenticated caller, used as the createdBy
 * fallback.
 */
export async function createMind(
  body: CreateMindInput,
  opts: { username?: string },
): Promise<LifecycleResult> {
  const { name } = body;
  const template = body.template ?? (await resolveTemplate(body.model));

  const nameErr = validateMindName(name);
  if (nameErr) return { ok: false, status: 400, error: nameErr };

  if (await findMind(name))
    return { ok: false, status: 409, error: `Mind already exists: ${name}` };

  // Refuse to create a mind the system can't run. With no AI provider configured
  // every mind spawns mute (no model to think with), so block creation here rather
  // than leave an unusable mind behind (#606). Mirrors the dashboard banner's copy.
  if (!isAiConfigured()) {
    return {
      ok: false,
      status: 409,
      error:
        "Minds cannot think yet — no AI provider is configured. Add a provider in Settings before creating a mind.",
    };
  }

  // Cap total minds to protect host resources. Central enforcement here covers
  // `volute mind create`, `volute seed create`, and spirit-driven seeds alike;
  // the error text is relayed verbatim to whoever asked.
  {
    const { mindLimitError, readGlobalConfig } = await import("../config/setup.js");
    const limitError = mindLimitError(await countCappedMinds(), readGlobalConfig().maxMinds);
    if (limitError) return { ok: false, status: 409, error: limitError };
  }

  ensureVoluteHome();
  const dest = mindDir(name);

  if (existsSync(dest)) return { ok: false, status: 409, error: "Mind directory already exists" };

  let composedDir: string;
  let manifest: TemplateManifest;
  try {
    const templatesRoot = findTemplatesRoot();
    ({ composedDir, manifest } = composeTemplate(templatesRoot, template));
  } catch (err) {
    // A missing/broken template throws (rather than exiting — #330); surface it as
    // a 500 instead of taking down the daemon. The detail is logged, not returned.
    llog.error(`failed to compose template ${template}`, log.errorData(err));
    return {
      ok: false,
      status: 500,
      error: "Failed to compose template",
    };
  }

  try {
    copyTemplateToDir(composedDir, dest, name, manifest);
    // Record the infrastructure this mind starts with, so a hook it removes on
    // day one is honoured rather than read as "never had it" (#811).
    seedInitLedger(name, applyInitFiles(dest));

    // Generate Ed25519 keypair for mind identity
    const { publicKeyPem } = generateIdentity(dest);

    // The model the mind will actually run (request, or default cognition model),
    // provider-qualified — feeds the credential warning below so pi minds created
    // from defaults are checked too.
    let effectiveModel: string | undefined = body.model;
    // Merge default settings into volute.json and config.json
    {
      const { readGlobalConfig: readGlobal } = await import("../config/setup.js");
      const mindDefaults = readGlobal().mindDefaults;
      const config = readVoluteConfig(dest);
      if (!config) throw new Error("Failed to read volute.json after identity generation");
      if (body.description) {
        config.profile = { ...config.profile, description: body.description };
      }
      if (!config.sleep) {
        config.sleep = mindDefaults?.sleep ?? {
          enabled: true,
          schedule: { sleep: "0 0 * * *", wake: "0 8 * * *" },
        };
      }
      if (!config.schedules || config.schedules.length === 0) {
        config.schedules = mindDefaults?.schedules ?? [defaultHeartbeatSchedule()];
      }
      // Apply cognition defaults
      const cog = mindDefaults?.cognition;
      if (cog) {
        if (cog.thinkingLevel != null && !config.thinkingLevel)
          config.thinkingLevel = cog.thinkingLevel;
        if (cog.spendCap != null && config.spendCap == null) config.spendCap = cog.spendCap;
        if (cog.spendCapPeriodMinutes != null && config.spendCapPeriodMinutes == null)
          config.spendCapPeriodMinutes = cog.spendCapPeriodMinutes;
      }
      writeVoluteConfig(dest, config);

      // Apply model (and compaction) to SDK config.json
      const modelId = body.model ?? cog?.model;
      effectiveModel = modelId ? qualifyModelId(modelId) : undefined;
      const sdkConfigPath = resolve(dest, "home/.config/config.json");
      if (modelId || cog?.compaction) {
        const existing = existsSync(sdkConfigPath)
          ? JSON.parse(readFileSync(sdkConfigPath, "utf-8"))
          : {};
        if (modelId) {
          existing.model = template === "pi" ? qualifyModelId(modelId) : unqualifyModelId(modelId);
        }
        if (cog?.compaction && !existing.compaction) {
          existing.compaction = cog.compaction;
        }
        writeFileSync(sdkConfigPath, `${JSON.stringify(existing, null, 2)}\n`);
      }
    }

    // Stamp prompts.json with current DB defaults
    const mindPrompts = await getMindPromptDefaults();
    writeFileSync(
      resolve(dest, "home/.config/prompts.json"),
      `${JSON.stringify(mindPrompts, null, 2)}\n`,
    );

    const port = await nextPort();
    // Use createdBy from body, or fall back to the authenticated user's username
    const createdBy = body.createdBy ?? opts.username;
    await addMind(name, port, body.stage, template, createdBy);
    try {
      await setMindTemplateHash(name, computeTemplateHash(template));
    } catch (err) {
      llog.warn(`failed to set template hash for ${name}`, log.errorData(err));
    }

    // Set up per-mind user isolation (no-ops if VOLUTE_ISOLATION !== "user")
    const homeDir = resolve(dest, "home");
    ensureVoluteGroup();
    createMindUser(name, homeDir);
    await chownMindDir(dest, name);

    // Install dependencies as mind user (chown already ran above)
    await npmInstallAsMind(dest, name);

    // git init + template branch + initial commit (before seed modifications
    // so that initTemplateBranch can git-add all template files)
    let gitWarning: string | undefined;
    try {
      const env = isIsolationEnabled() ? { ...process.env, HOME: homeDir } : undefined;
      await gitExec(["init"], { cwd: dest, mindName: name, env });
      await configureGitIdentity(name, { cwd: dest, mindName: name, env });
      await initTemplateBranch(dest, composedDir, manifest, name, env);
    } catch (err) {
      llog.error(`git setup failed for ${name}`, log.errorData(err));
      rmSync(resolve(dest, ".git"), { recursive: true, force: true });
      gitWarning =
        "Git setup failed — variants and upgrades won't be available until git is initialized.";
    }

    if (body.stage === "seed") {
      // Write orientation SOUL.md
      const descLine = body.description
        ? `\nYour creator described you as: "${body.description}"\n`
        : "";
      const seedSoulRaw =
        body.seedSoul ?? (await getPrompt("seed_soul", { name, description: descLine }));
      // getPrompt already substituted; custom seedSoul needs substitution too
      const seedSoul = body.seedSoul
        ? substitute(seedSoulRaw, { name, description: descLine })
        : seedSoulRaw;
      writeFileSync(resolve(dest, "home/SOUL.md"), seedSoul);
    }

    // Install skills from shared pool (after git init so installSkill can commit)
    let skillSet =
      body.skills ?? (body.stage === "seed" ? SEED_SKILLS : getStandardSkillsWithExtensions());

    // Add imagegen skill for seeds when image generation is enabled
    if (body.stage === "seed" && !body.skills) {
      const { isImagegenEnabled } = await import("../config/setup.js");
      if (isImagegenEnabled()) {
        skillSet = [...skillSet, "imagegen"];
      }
    }
    const skillWarnings: string[] = [];
    for (const skillId of skillSet) {
      try {
        await installSkill(name, dest, skillId);
      } catch (err) {
        llog.error(`failed to install skill ${skillId} for ${name}`, log.errorData(err));
        skillWarnings.push(`Failed to install skill: ${skillId}`);
      }
    }

    // Default autonomy: minds created directly as full minds get working
    // dreaming out of the box; seeds get it at sprout (#581)
    if (body.stage !== "seed") {
      skillWarnings.push(...setupDefaultDreaming(dest).warnings);
    }

    // Add nurture schedule to spirit if this is a seed
    if (body.stage === "seed") {
      try {
        const spiritName = getSpiritName();
        const spiritEntry = await findMind(spiritName);
        if (spiritEntry) {
          const { spiritDir } = await import("./spirit.js");
          const sDir = spiritEntry.dir ?? spiritDir();
          const spiritConfig = readVoluteConfig(sDir) ?? {};
          const schedules = spiritConfig.schedules ?? [];
          const nurtureId = `nurture-${name}`;
          if (!schedules.some((s) => s.id === nurtureId)) {
            schedules.push({
              id: nurtureId,
              cron: process.env.VOLUTE_NURTURE_CRON ?? "*/5 * * * *",
              script: `volute seed check ${name} --nurture`,
              enabled: true,
              whileSleeping: "skip",
            });
            spiritConfig.schedules = schedules;
            writeVoluteConfig(sDir, spiritConfig);
            const { getScheduler } = await import("../daemon/scheduler.js");
            getScheduler().loadSchedules(spiritName, sDir);
          }
        }
      } catch (err) {
        llog.warn(`failed to add nurture schedule for ${name}`, log.errorData(err));
      }
    }

    // Overwrite SOUL.md / MEMORY.md if custom defaults are set in DB
    if (body.stage !== "seed") {
      const customSoul = await getPromptIfCustom("default_soul");
      if (customSoul) {
        writeFileSync(resolve(dest, "home/SOUL.md"), customSoul.replace(/\{\{name\}\}/g, name));
      }
      const customMemory = await getPromptIfCustom("default_memory");
      if (customMemory) {
        writeFileSync(resolve(dest, "home/MEMORY.md"), customMemory);
      }
    }

    // Fix ownership after all root git/file operations (git objects, skill
    // installs, and SOUL.md/MEMORY.md writes above must end up mind-owned so
    // the mind can modify its own identity files under user isolation)
    await chownMindDir(dest, name);

    // Auto-publish public key to volute.systems (non-blocking)
    publishPublicKey(name, publicKeyPem).catch((err: unknown) =>
      llog.warn(`failed to publish key for ${name}`, { error: (err as Error).message }),
    );

    fireWebhook({
      event: "mind_created",
      mind: name,
      data: {
        name,
        port,
        stage: body.stage ?? "sprouted",
        template,
        description: body.description,
      },
    });

    // Announce to the commons channel. Fire-and-forget, but surface failures — this is the
    // primary producer of commons event rows, and announceToCommons propagates DB errors
    // (ensureCommonsChannel/addMessage/getParticipants), so a silent swallow would make the
    // join moment vanish without a trace.
    announceToCommons(`${name} has joined`).catch((err) =>
      llog.warn(`failed to announce ${name} joining the commons`, log.errorData(err)),
    );

    // Warn (don't block) when the mind will spawn without usable model credentials,
    // so a mute-on-first-turn mind is caught at creation rather than in silence (#573).
    // The mind is already created — an advisory check must never fail creation, so
    // swallow any hiccup and just omit the warning.
    const credentialWarning = await missingCredentialWarning(template, effectiveModel, name).catch(
      (err) => {
        llog.warn(`credential check failed for ${name}`, log.errorData(err));
        return null;
      },
    );

    return {
      ok: true,
      body: {
        ok: true,
        name,
        port,
        stage: body.stage ?? "sprouted",
        message: `Created mind: ${name} (port ${port})`,
        ...(gitWarning && { warning: gitWarning }),
        ...(credentialWarning && { credentialWarning }),
        ...(skillWarnings.length > 0 && { skillWarnings }),
      },
    };
  } catch (err) {
    // Clean up partial state
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    try {
      await removeMind(name);
    } catch (cleanupErr) {
      llog.warn(`failed to clean up registry for ${name}`, log.errorData(cleanupErr));
    }
    llog.error(`failed to create mind ${name}`, log.errorData(err));
    return {
      ok: false,
      status: 500,
      error: "Failed to create mind",
    };
  } finally {
    rmSync(composedDir, { recursive: true, force: true });
  }
}

/** Import a mind from a .volute archive (already extracted to tempDir by the CLI). */
export async function importMindFromArchive(
  tempDir: string,
  nameOverride: string | undefined,
  manifest: ExportManifest,
): Promise<LifecycleResult> {
  const extractedMindDir = resolve(tempDir, "mind");
  if (!existsSync(extractedMindDir)) {
    return { ok: false, status: 400, error: "Invalid archive: missing mind/ directory" };
  }

  if (!manifest?.includes || !manifest.name || !manifest.template) {
    return { ok: false, status: 400, error: "Invalid archive manifest" };
  }

  // Route home-only archives through the template-composed import path
  if (isHomeOnlyArchive(manifest)) {
    return importFromHomeOnlyArchive(tempDir, extractedMindDir, nameOverride, manifest);
  }

  return importFromFullArchive(tempDir, extractedMindDir, nameOverride, manifest);
}

/** Import a full archive (contains src/, home/, .mind/) — original behavior. */
async function importFromFullArchive(
  tempDir: string,
  extractedMindDir: string,
  nameOverride: string | undefined,
  manifest: ExportManifest,
): Promise<LifecycleResult> {
  const name = nameOverride ?? manifest.name;

  const nameErr = validateMindName(name);
  if (nameErr) return { ok: false, status: 400, error: nameErr };

  if (await findMind(name))
    return { ok: false, status: 409, error: `Mind already exists: ${name}` };

  ensureVoluteHome();
  const dest = mindDir(name);
  if (existsSync(dest)) return { ok: false, status: 409, error: "Mind directory already exists" };

  try {
    // Copy extracted mind directory to final location
    cpSync(extractedMindDir, dest, { recursive: true });

    // This path composes no template, so there is no applyInitFiles return to
    // seed from — read the archive's own `.local/` instead. An archive carries
    // an absence faithfully, and a mind that deleted a hook before it was
    // exported should still have deleted it on the new host (#811).
    seedInitLedger(name, listInfrastructureOnDisk(resolve(dest, "home")));

    // Generate new identity if not included in archive
    if (!manifest.includes.identity) {
      generateIdentity(dest);
    }

    // Copy state files (env.json) to centralized state dir
    const state = stateDir(name);
    mkdirSync(state, { recursive: true });

    const envJson = resolve(tempDir, "state/env.json");
    if (existsSync(envJson)) {
      cpSync(envJson, resolve(state, "env.json"));
    }

    // Assign port and register
    const port = await nextPort();
    await addMind(name, port, manifest.stage, manifest.template);
    try {
      await setMindTemplateHash(name, computeTemplateHash(manifest.template));
    } catch (err) {
      llog.warn(`failed to set template hash for ${name}`, log.errorData(err));
    }

    // Set up per-mind user isolation
    const homeDir = resolve(dest, "home");
    ensureVoluteGroup();
    createMindUser(name, homeDir);
    await chownMindDir(dest, name);

    // Install dependencies
    await npmInstallAsMind(dest, name);

    // Import history and sessions
    await importHistoryFromArchive(name, tempDir);
    importSessionsFromArchive(dest, tempDir);

    // git init if .git/ doesn't exist (non-fatal — mind works without git)
    if (!existsSync(resolve(dest, ".git"))) {
      try {
        const env = isIsolationEnabled()
          ? { ...process.env, HOME: resolve(dest, "home") }
          : undefined;
        await gitExec(["init"], { cwd: dest, mindName: name, env });
        await configureGitIdentity(name, { cwd: dest, mindName: name, env });
        await gitExec(["add", "-A"], { cwd: dest, mindName: name, env });
        await gitExec(["commit", "-m", "import from archive"], { cwd: dest, mindName: name, env });
      } catch (err) {
        llog.error(`git setup failed for imported mind ${name}`, log.errorData(err));
        rmSync(resolve(dest, ".git"), { recursive: true, force: true });
      }
    }

    // Fix ownership
    await chownMindDir(dest, name);

    // Clean up temp dir
    rmSync(tempDir, { recursive: true, force: true });

    return {
      ok: true,
      body: { ok: true, name, port, message: `Imported mind: ${name} (port ${port})` },
    };
  } catch (err) {
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    try {
      await removeMind(name);
    } catch (cleanupErr) {
      llog.error(`Failed to clean up registry for ${name}`, log.errorData(cleanupErr));
    }
    rmSync(tempDir, { recursive: true, force: true });
    llog.error(`failed to import mind ${name}`, log.errorData(err));
    return {
      ok: false,
      status: 500,
      error: "Failed to import mind",
    };
  }
}

/** Import a home-only archive by composing a fresh template and overlaying mind-owned files. */
async function importFromHomeOnlyArchive(
  tempDir: string,
  extractedMindDir: string,
  nameOverride: string | undefined,
  manifest: ExportManifest,
): Promise<LifecycleResult> {
  const name = nameOverride ?? manifest.name;

  const nameErr = validateMindName(name);
  if (nameErr) return { ok: false, status: 400, error: nameErr };

  if (await findMind(name))
    return { ok: false, status: 409, error: `Mind already exists: ${name}` };

  ensureVoluteHome();
  const dest = mindDir(name);
  if (existsSync(dest)) return { ok: false, status: 409, error: "Mind directory already exists" };

  const templatesRoot = findTemplatesRoot();
  const { composedDir, manifest: templateManifest } = composeTemplate(
    templatesRoot,
    manifest.template,
  );

  try {
    // 1. Compose fresh template
    copyTemplateToDir(composedDir, dest, name, templateManifest);
    seedInitLedger(name, applyInitFiles(dest));

    // 2. Overlay home/ from archive (archive files win over template defaults,
    //    and a hook the exporting host recorded as given but the archive does
    //    not carry is a removal the mind meant — see overlayArchiveHome).
    //    The carried ledger is archive content, so it is filtered to the
    //    infrastructure namespace on the way in for the same reason
    //    applyInitFiles filters its own return: nothing outside `.local/` may
    //    ever be recorded as framework-given.
    const given = [...readInitLedgerFile(resolve(tempDir, ARCHIVE_INIT_LEDGER), name)].filter(
      isInitInfrastructure,
    );
    const homeDir = resolve(dest, "home");
    overlayArchiveHome(resolve(extractedMindDir, "home"), homeDir, given);

    // The archive's `.local/` has replaced the template's, so the ledger seeded
    // from applyInitFiles above describes a tree that is no longer there. What
    // Volute has ever given this mind is the union of the two hosts' records:
    // dropping the carried half would read every refusal as "never had it" and
    // undo it on the first upgrade, which is the move #811 exists to survive.
    seedInitLedger(name, [...given, ...listInfrastructureOnDisk(homeDir)]);

    // 3. Overlay .mind/ from archive (preserves schedules, etc.)
    const extractedMindInternal = resolve(extractedMindDir, ".mind");
    if (existsSync(extractedMindInternal)) {
      cpSync(extractedMindInternal, resolve(dest, ".mind"), { recursive: true });
    }

    // 4. Generate new identity if not included in archive
    const identityDir = resolve(dest, ".mind/identity");
    let publicKeyPem: string;
    if (!manifest.includes.identity || !existsSync(resolve(identityDir, "private.pem"))) {
      ({ publicKeyPem } = generateIdentity(dest));
    } else {
      publicKeyPem = readFileSync(resolve(identityDir, "public.pem"), "utf-8");
    }

    // 5. Stamp prompts.json only if archive didn't provide one
    const promptsPath = resolve(dest, "home/.config/prompts.json");
    if (!existsSync(promptsPath)) {
      const mindPrompts = await getMindPromptDefaults();
      writeFileSync(promptsPath, `${JSON.stringify(mindPrompts, null, 2)}\n`);
    }

    // 6. Copy state files (env.json) to centralized state dir
    const state = stateDir(name);
    mkdirSync(state, { recursive: true });

    const envJson = resolve(tempDir, "state/env.json");
    if (existsSync(envJson)) {
      cpSync(envJson, resolve(state, "env.json"));
    }

    // 7. Register with correct stage and template
    const port = await nextPort();
    await addMind(name, port, manifest.stage, manifest.template);

    // 8. User isolation setup
    ensureVoluteGroup();
    createMindUser(name, homeDir);
    await chownMindDir(dest, name);

    // 9. npm install
    await npmInstallAsMind(dest, name);

    // 10. Git init with template branch (enables upgrades)
    let gitWarning: string | undefined;
    try {
      const env = isIsolationEnabled() ? { ...process.env, HOME: homeDir } : undefined;
      await gitExec(["init"], { cwd: dest, mindName: name, env });
      await configureGitIdentity(name, { cwd: dest, mindName: name, env });
      await initTemplateBranch(dest, composedDir, templateManifest, name, env);
    } catch (err) {
      llog.error(`git setup failed for imported mind ${name}`, log.errorData(err));
      rmSync(resolve(dest, ".git"), { recursive: true, force: true });
      gitWarning =
        "Git setup failed — variants and upgrades won't be available until git is initialized.";
    }

    // 11. Install skills based on stage
    const skillSet = manifest.stage === "seed" ? SEED_SKILLS : getStandardSkillsWithExtensions();
    const skillWarnings: string[] = [];
    for (const skillId of skillSet) {
      try {
        await installSkill(name, dest, skillId);
      } catch (err) {
        llog.error(`failed to install skill ${skillId} for ${name}`, log.errorData(err));
        skillWarnings.push(`Failed to install skill: ${skillId}`);
      }
    }

    // 13. Import history and sessions from archive
    await importHistoryFromArchive(name, tempDir);
    importSessionsFromArchive(dest, tempDir);

    // 14. Fix ownership, publish public key
    await chownMindDir(dest, name);
    publishPublicKey(name, publicKeyPem).catch((err: unknown) =>
      llog.warn(`failed to publish key for ${name}`, { error: (err as Error).message }),
    );

    // 15. Clean up
    rmSync(tempDir, { recursive: true, force: true });

    return {
      ok: true,
      body: {
        ok: true,
        name,
        port,
        stage: manifest.stage ?? "sprouted",
        message: `Imported mind: ${name} (port ${port})`,
        ...(gitWarning && { warning: gitWarning }),
        ...(skillWarnings.length > 0 && { skillWarnings }),
      },
    };
  } catch (err) {
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    try {
      await removeMind(name);
    } catch (cleanupErr) {
      llog.error(`Failed to clean up registry for ${name}`, log.errorData(cleanupErr));
    }
    rmSync(tempDir, { recursive: true, force: true });
    llog.error(`failed to import mind ${name}`, log.errorData(err));
    return {
      ok: false,
      status: 500,
      error: "Failed to import mind",
    };
  } finally {
    rmSync(composedDir, { recursive: true, force: true });
  }
}

/** Import history rows from archive into the database. */
async function importHistoryFromArchive(name: string, tempDir: string): Promise<void> {
  const historyJsonl = resolve(tempDir, "history.jsonl");
  if (!existsSync(historyJsonl)) return;

  try {
    const db = await getDb();
    const lines = readFileSync(historyJsonl, "utf-8").trim().split("\n");
    let imported = 0;
    let failed = 0;
    for (const line of lines) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        if (!row.type) {
          failed++;
          continue;
        }
        await db.insert(mindHistory).values({
          mind: name,
          channel: row.channel ?? null,
          // Archives are long-lived files: pre-rename exports carry `session`.
          thread: row.thread ?? row.session ?? null,
          sender: row.sender ?? null,
          message_id: row.message_id ?? null,
          type: row.type,
          content: row.content ?? null,
          metadata: row.metadata ?? null,
          created_at: row.created_at ?? new Date().toISOString(),
        });
        imported++;
      } catch (lineErr) {
        llog.warn("Failed to import history line", log.errorData(lineErr));
        failed++;
      }
    }
    if (failed > 0) {
      llog.warn(`History import: ${imported} imported, ${failed} failed`);
    }
  } catch (err) {
    llog.error("Failed to open database for history import", log.errorData(err));
  }
}

/** Import session files from archive into .mind/sessions/. Non-fatal on failure. */
function importSessionsFromArchive(dest: string, tempDir: string): void {
  const sessionsDir = resolve(tempDir, "sessions");
  if (!existsSync(sessionsDir)) return;

  try {
    const destSessions = resolve(dest, ".mind/sessions");
    mkdirSync(destSessions, { recursive: true });
    for (const file of readdirSync(sessionsDir)) {
      cpSync(resolve(sessionsDir, file), resolve(destSessions, file));
    }
  } catch (err) {
    llog.error("Failed to import sessions from archive", log.errorData(err));
  }
}

/** Input for {@link importOpenClawWorkspace}. */
export interface ImportOpenClawInput {
  workspacePath?: string;
  name?: string;
  template?: string;
  sessionPath?: string;
}

/** Import a mind from an OpenClaw workspace directory (SOUL.md + IDENTITY.md + optional session). */
export async function importOpenClawWorkspace(body: ImportOpenClawInput): Promise<LifecycleResult> {
  const wsDir = body.workspacePath;
  if (
    !wsDir ||
    !existsSync(resolve(wsDir, "SOUL.md")) ||
    !existsSync(resolve(wsDir, "IDENTITY.md"))
  ) {
    return { ok: false, status: 400, error: "Invalid workspace: missing SOUL.md or IDENTITY.md" };
  }

  const soul = readFileSync(resolve(wsDir, "SOUL.md"), "utf-8");
  const identity = readFileSync(resolve(wsDir, "IDENTITY.md"), "utf-8");
  const userPath = resolve(wsDir, "USER.md");
  const user = existsSync(userPath) ? readFileSync(userPath, "utf-8") : "";

  const name = body.name ?? parseNameFromIdentity(identity) ?? "imported-mind";
  const template = body.template ?? "claude";

  const nameErr = validateMindName(name);
  if (nameErr) return { ok: false, status: 400, error: nameErr };

  if (await findMind(name))
    return { ok: false, status: 409, error: `Mind already exists: ${name}` };

  const mergedSoul = `${soul.trimEnd()}\n\n---\n\n${identity.trimEnd()}\n`;
  const mergedMemoryExtra = user ? `\n\n---\n\n${user.trimEnd()}\n` : "";

  ensureVoluteHome();
  const dest = mindDir(name);

  if (existsSync(dest)) return { ok: false, status: 409, error: "Mind directory already exists" };

  const templatesRoot = findTemplatesRoot();
  const { composedDir, manifest } = composeTemplate(templatesRoot, template);

  try {
    copyTemplateToDir(composedDir, dest, name, manifest);

    seedInitLedger(name, applyInitFiles(dest));

    // Generate Ed25519 keypair for mind identity
    const { publicKeyPem: importPublicKey } = generateIdentity(dest);

    // Write SOUL.md (with IDENTITY.md merged in)
    writeFileSync(resolve(dest, "home/SOUL.md"), mergedSoul);

    // Copy or create MEMORY.md
    const wsMemoryPath = resolve(wsDir, "MEMORY.md");
    const hasMemory = existsSync(wsMemoryPath);
    if (hasMemory) {
      const existingMemory = readFileSync(wsMemoryPath, "utf-8");
      writeFileSync(
        resolve(dest, "home/MEMORY.md"),
        `${existingMemory.trimEnd()}${mergedMemoryExtra}`,
      );
    } else if (user) {
      writeFileSync(resolve(dest, "home/MEMORY.md"), `${user.trimEnd()}\n`);
    }

    // Copy memory/*.md daily logs
    const wsMemoryDir = resolve(wsDir, "memory");
    let dailyLogCount = 0;
    if (existsSync(wsMemoryDir)) {
      const destMemoryDir = resolve(dest, "home/memory");
      const files = readdirSync(wsMemoryDir).filter((f) => f.endsWith(".md"));
      for (const file of files) {
        cpSync(resolve(wsMemoryDir, file), resolve(destMemoryDir, file));
      }
      dailyLogCount = files.length;
    }

    // Assign port and register
    const port = await nextPort();
    await addMind(name, port, undefined, template);
    try {
      await setMindTemplateHash(name, computeTemplateHash(template));
    } catch (err) {
      llog.warn(`failed to set template hash for ${name}`, log.errorData(err));
    }

    // Set up per-mind user isolation (no-ops if VOLUTE_ISOLATION !== "user")
    const homeDir = resolve(dest, "home");
    ensureVoluteGroup();
    createMindUser(name, homeDir);
    await chownMindDir(dest, name);

    // Install dependencies as mind user (chown already ran above)
    await npmInstallAsMind(dest, name);

    // Consolidate memory if no MEMORY.md but daily logs exist
    if (!hasMemory && dailyLogCount > 0) {
      await consolidateMemory(dest);
    }

    // git init + initial commit
    const env = isIsolationEnabled() ? { ...process.env, HOME: resolve(dest, "home") } : undefined;
    await gitExec(["init"], { cwd: dest, mindName: name, env });
    await configureGitIdentity(name, { cwd: dest, mindName: name, env });
    await gitExec(["add", "-A"], { cwd: dest, mindName: name, env });
    await gitExec(["commit", "-m", "import from OpenClaw"], { cwd: dest, mindName: name, env });

    // Import session
    const sessionFile = body.sessionPath ? resolve(body.sessionPath) : findOpenClawSession(wsDir);
    if (sessionFile && existsSync(sessionFile)) {
      if (template === "pi") {
        importPiSession(sessionFile, dest);
      } else if (template === "claude") {
        const sessionId = convertSession({ sessionPath: sessionFile, projectDir: dest });
        const mindRuntimeDir = resolve(dest, ".mind");
        mkdirSync(mindRuntimeDir, { recursive: true });
        writeFileSync(resolve(mindRuntimeDir, "session.json"), JSON.stringify({ sessionId }));
      }
    }

    // Import OpenClaw connectors as system bridges (non-fatal)
    importOpenClawConnectors(name, dest);

    // Fix ownership after root git/file operations
    await chownMindDir(dest, name);

    // Auto-publish public key to volute.systems (non-blocking)
    publishPublicKey(name, importPublicKey).catch((err: unknown) =>
      llog.warn(`failed to publish key for ${name}`, { error: (err as Error).message }),
    );

    return {
      ok: true,
      body: { ok: true, name, port, message: `Imported mind: ${name} (port ${port})` },
    };
  } catch (err) {
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    try {
      await removeMind(name);
    } catch (cleanupErr) {
      llog.warn(`failed to clean up registry for ${name}`, log.errorData(cleanupErr));
    }
    llog.error(`failed to import mind ${name}`, log.errorData(err));
    return {
      ok: false,
      status: 500,
      error: "Failed to import mind",
    };
  } finally {
    rmSync(composedDir, { recursive: true, force: true });
  }
}

/** Input for {@link createVariant}. The caller validates the name and parent first. */
export interface CreateVariantInput {
  /** Base mind being split from (owns projectRoot). */
  parentName: string;
  projectRoot: string;
  variantName: string;
  soul?: string;
  port?: number;
  noStart?: boolean;
  purpose?: string;
}

export type CreateVariantResult =
  | {
      ok: true;
      variant: { name: string; branch: string; path: string; port: number; purpose?: string };
    }
  | { ok: false; status: 409 | 500; error: string };

/**
 * Split a variant off a base mind: create the git worktree, install deps, register
 * it, and (unless noStart) start its server with birth context queued. Moved out of
 * the POST `/:name/variants` route body verbatim (#330). Every step past worktree
 * creation is rolled back on failure so a retry with the same name isn't blocked by
 * a half-created variant (#444). The caller establishes the parent<->variant dialogue
 * on success.
 */
export async function createVariant(input: CreateVariantInput): Promise<CreateVariantResult> {
  const { parentName, projectRoot, variantName, purpose } = input;
  const variantDir = resolve(projectRoot, ".variants", variantName);

  if (existsSync(variantDir)) {
    return { ok: false, status: 409, error: `Variant directory already exists: ${variantDir}` };
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
      await chownMindDir(projectRoot, parentName);
    } catch (err) {
      llog.warn(
        `failed to restore ownership after worktree-add failure for ${parentName}`,
        log.errorData(err),
      );
      error += ` Restoring mind ownership also failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    return { ok: false, status: 500, error };
  }

  // Everything after the worktree is created is rolled back on failure so a
  // retry with the same name isn't blocked by a half-created variant (#444).
  const rollbackSplit = async () => {
    try {
      await cleanupVariant(variantName, parentName, projectRoot, variantDir, { stop: true });
    } catch (err) {
      llog.warn(`failed to roll back split of ${variantName}`, log.errorData(err));
    }
  };

  // Fix ownership before npm install so it runs as the mind user. This is the
  // first step past worktree creation, so a throw here (chownMindDir re-throws
  // under isolation) must also roll back or it strands the worktree+branch.
  try {
    await chownMindDir(projectRoot, parentName);
  } catch (e: unknown) {
    await rollbackSplit();
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 500, error: `Failed to prepare variant ownership: ${msg}` };
  }

  // Install dependencies
  try {
    if (isIsolationEnabled()) {
      const [cmd, args] = await wrapForIsolation("npm", ["install"], parentName);
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
    return { ok: false, status: 500, error: `npm install failed: ${msg}` };
  }

  // Write SOUL.md if provided
  if (input.soul) {
    writeFileSync(resolve(variantDir, "home/SOUL.md"), input.soul);
  }

  const variantPort = input.port ?? (await nextPort());

  // Register variant in DB
  try {
    await addVariant(variantName, parentName, variantPort, variantDir, variantName, purpose);
  } catch (e: unknown) {
    await rollbackSplit();
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 500, error: `Failed to register variant: ${msg}` };
  }

  // Queue the variant's birth context now, independent of --no-start: it's the
  // variant's first message — who it is, where it came from, and why it was split
  // off — and deliverPendingContext fires on whatever first start happens, so a
  // variant started manually later still gets oriented. Pending context is
  // persisted under state/<variant>/ (#330), so it survives a daemon restart
  // before that first start too.
  const manager = getMindManager();
  manager.setPendingContext(variantName, { type: "split", parent: parentName, purpose });

  if (!input.noStart) {
    try {
      await manager.startMind(variantName);
    } catch (e: unknown) {
      await rollbackSplit();
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, status: 500, error: `Variant created but failed to start: ${msg}` };
    }
  }

  return {
    ok: true,
    variant: {
      name: variantName,
      branch: variantName,
      path: variantDir,
      port: variantPort,
      ...(purpose && { purpose }),
    },
  };
}
