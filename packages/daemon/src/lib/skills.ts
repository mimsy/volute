import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { readGlobalConfig, writeGlobalConfig } from "./config/setup.js";
import { getDb } from "./db.js";
import { readInitLedgerFile, writeLedgerFile } from "./mind/init-ledger.js";
import { chownMindDir } from "./mind/isolation.js";
import { mindDir, readRegistry, stateDir, voluteHome } from "./mind/registry.js";
import { sharedSkills } from "./schema.js";
import { exec, gitExec } from "./util/exec.js";
import log from "./util/logger.js";

const VALID_SKILL_ID = /^[a-zA-Z0-9_-]+$/;

/** Skills installed for seed minds (pre-sprout) */
export const SEED_SKILLS = ["orientation", "memory"];

/** Skills installed for fully sprouted minds */
export const STANDARD_SKILLS = ["volute-mind", "memory", "dreaming", "resonance"];

/**
 * Returns the configured default skills for new minds.
 * Reads from config.json `defaultSkills` if set, otherwise falls back to
 * STANDARD_SKILLS + extension-contributed standard skills.
 */
export function getStandardSkillsWithExtensions(): string[] {
  const config = readGlobalConfig();
  if (config.defaultSkills) return [...config.defaultSkills];
  // Fallback before initDefaultSkills has run — no extension skills available synchronously
  return [...STANDARD_SKILLS];
}

/**
 * Initialize defaultSkills in config if not already set.
 * Called on daemon startup after extensions are loaded, so extension standard skills are included.
 */
export async function initDefaultSkills(): Promise<void> {
  const config = readGlobalConfig();

  let extensionSkills: string[] = [];
  try {
    // Lazy import: extensions.ts may not be loaded yet at module evaluation time
    const { getExtensionStandardSkills } = await import("./extensions.js");
    extensionSkills = getExtensionStandardSkills();
  } catch (err) {
    log.warn("failed to load extension standard skills during init", log.errorData(err));
  }

  const desired = new Set([...STANDARD_SKILLS, ...extensionSkills]);
  const current = config.defaultSkills ?? [];
  const removed = new Set(config.removedDefaultSkills ?? []);

  // Only add new standard/extension skills that the admin hasn't explicitly removed
  const toAdd = [...desired].filter((s) => !current.includes(s) && !removed.has(s));

  // Drop defaults whose skill no longer exists in the pool — e.g. one contributed
  // by an extension that has since been removed. Without this, every new mind
  // fails to install a skill that cannot be installed. Runs only when the pool is
  // populated, so a failed sync can't empty the config.
  const pool = new Set((await listSharedSkills()).map((s) => s.id));
  const stale = pool.size > 0 ? current.filter((s) => !pool.has(s)) : [];

  if (toAdd.length === 0 && stale.length === 0 && current.length > 0) return;

  const merged = [...new Set([...current, ...toAdd])].filter((s) => !stale.includes(s));
  writeGlobalConfig({ ...config, defaultSkills: merged });
  if (stale.length > 0) log.info(`dropped default skills not in the pool: ${stale.join(", ")}`);
  log.info(`updated default skills: ${merged.join(", ")}`);
}

function validateSkillId(id: string): void {
  if (!id || !VALID_SKILL_ID.test(id)) {
    throw new Error(`Invalid skill ID: ${id}`);
  }
}

// --- Shared skill operations ---

export function sharedSkillsDir(): string {
  return resolve(voluteHome(), "skills");
}

export function parseSkillMd(content: string): {
  name: string;
  description: string;
  npmDependencies: string[];
  hooks: Record<string, string>;
  bin: string | null;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { name: "", description: "", npmDependencies: [], hooks: {}, bin: null };
  const frontmatter = match[1];

  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
  const depsMatch = frontmatter.match(/^\s*npm-dependencies:\s*(.+)$/m);
  const binMatch = frontmatter.match(/^\s*bin:\s*(.+)$/m);

  // Parse hooks from metadata block using indentation-aware parsing.
  // hooks: must appear under metadata:, and hook entries are indented deeper than hooks:.
  const hooks: Record<string, string> = {};
  const lines = frontmatter.split("\n");
  let inHooks = false;
  let hooksIndent = -1;
  for (const line of lines) {
    if (!line.trim()) continue;

    // Detect "hooks:" key — must be indented (i.e., under metadata:)
    const hooksStart = line.match(/^(\s+)hooks:\s*$/);
    if (hooksStart) {
      inHooks = true;
      hooksIndent = hooksStart[1].length;
      continue;
    }

    if (inHooks) {
      // Check indentation — hook entries must be deeper than hooks:
      const lineIndentMatch = line.match(/^(\s*)/);
      const lineIndent = lineIndentMatch ? lineIndentMatch[1].length : 0;

      // If indentation is <= hooks: level, we've left the hooks block
      if (lineIndent <= hooksIndent) {
        inHooks = false;
        continue;
      }

      // Parse "event-name: script/path" entries
      const hookMatch = line.match(/^\s+([a-z0-9-]+):\s*(.+)$/);
      if (hookMatch) {
        hooks[hookMatch[1]] = hookMatch[2].trim();
      }
    }
  }

  return {
    name: nameMatch?.[1].trim() ?? "",
    description: descMatch?.[1].trim() ?? "",
    npmDependencies: depsMatch
      ? depsMatch[1]
          .trim()
          .split(/[\s,]+/)
          .filter(Boolean)
      : [],
    hooks,
    bin: binMatch?.[1].trim() ?? null,
  };
}

export type SharedSkill = {
  id: string;
  name: string;
  description: string;
  author: string;
  version: number;
  created_at: string;
  updated_at: string;
};

export async function listSharedSkills(): Promise<SharedSkill[]> {
  const db = await getDb();
  return db.select().from(sharedSkills).all();
}

export async function getSharedSkill(id: string): Promise<SharedSkill | undefined> {
  const db = await getDb();
  return db.select().from(sharedSkills).where(eq(sharedSkills.id, id)).get();
}

export async function importSkillFromDir(sourceDir: string, author: string): Promise<SharedSkill> {
  const skillMdPath = join(sourceDir, "SKILL.md");
  if (!existsSync(skillMdPath)) {
    throw new Error("SKILL.md not found in source directory");
  }

  const content = readFileSync(skillMdPath, "utf-8");
  const { name, description } = parseSkillMd(content);
  const id = basename(sourceDir);

  if (!id || id === "." || id === "..") {
    throw new Error("Invalid skill directory name");
  }
  validateSkillId(id);

  const db = await getDb();
  const existing = await db.select().from(sharedSkills).where(eq(sharedSkills.id, id)).get();

  // A publisher may only overwrite a pool entry it already authors. This blocks
  // one mind from hijacking another mind's skill (or a protected built-in
  // `volute` / extension `ext:*` skill) — skills carry hooks and bin scripts
  // that later execute inside installers' processes, so a cross-author
  // overwrite is a code-execution boundary. Trusted callers pass their own
  // matching author (`volute`, `ext:<id>`), so their re-syncs still succeed.
  //
  // Exception: a PROTECTED caller (`volute` / `ext:*`, only reachable from
  // built-in / extension sync — never from a mind, since a mind named "volute"
  // is the trusted spirit) may RECLAIM an id currently squatted by a mind. A
  // mind could otherwise pre-register an id Volute later ships as a built-in,
  // permanently poisoning it: the sync would throw and fail open, and every
  // installer would get the squatter's code.
  if (existing && existing.author !== author) {
    const existingProtected = existing.author === "volute" || existing.author.startsWith("ext:");
    const callerProtected = author === "volute" || author.startsWith("ext:");
    const reclaim = callerProtected && !existingProtected;
    if (!reclaim) {
      throw new Error(
        existingProtected
          ? `Cannot overwrite protected skill "${id}" (authored by "${existing.author}")`
          : `Cannot overwrite skill "${id}" authored by "${existing.author}"`,
      );
    }
  }

  const destDir = join(sharedSkillsDir(), id);
  // Clean destination before copying to remove files deleted from source
  if (existsSync(destDir)) rmSync(destDir, { recursive: true });
  mkdirSync(destDir, { recursive: true });

  cpSync(sourceDir, destDir, { recursive: true });

  // Remove .upstream.json if present (it's a mind-side tracking file)
  const upstreamPath = join(destDir, ".upstream.json");
  if (existsSync(upstreamPath)) rmSync(upstreamPath);

  const version = existing ? existing.version + 1 : 1;

  await db
    .insert(sharedSkills)
    .values({ id, name: name || id, description, author, version })
    .onConflictDoUpdate({
      target: sharedSkills.id,
      set: {
        name: name || id,
        description,
        author,
        version,
        updated_at: sql`(datetime('now'))`,
      },
    });

  const row = await db.select().from(sharedSkills).where(eq(sharedSkills.id, id)).get();
  if (!row) throw new Error(`Failed to upsert shared skill: ${id}`);
  return row;
}

export async function removeSharedSkill(id: string): Promise<void> {
  const db = await getDb();
  const existing = await db.select().from(sharedSkills).where(eq(sharedSkills.id, id)).get();
  if (!existing) throw new Error(`Shared skill not found: ${id}`);

  await db.delete(sharedSkills).where(eq(sharedSkills.id, id));
  const dir = join(sharedSkillsDir(), id);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
}

// --- Mind skill operations ---

const TEMPLATE_SKILLS_DIR: Record<string, string> = {
  claude: ".claude/skills",
  pi: ".pi/skills",
  codex: ".agents/skills",
};

/**
 * The template a mind's home/ is laid out for, from its mechanics-doc marker:
 * home/AGENTS.md → codex, home/MINDS.md → pi, home/CLAUDE.md → claude. Undefined
 * when there is no marker. This is what the *disk* says — it can disagree with the
 * registry's `template` after a switch that never reached home/.
 */
export function detectHomeTemplate(dir: string): string | undefined {
  const home = resolve(dir, "home");
  if (existsSync(join(home, "AGENTS.md"))) return "codex";
  if (existsSync(join(home, "MINDS.md"))) return "pi";
  if (existsSync(join(home, "CLAUDE.md"))) return "claude";
  return undefined;
}

/** Resolve the skills directory for a mind, from its home's template (claude when unmarked). */
export function mindSkillsDir(dir: string): string {
  const subdir = TEMPLATE_SKILLS_DIR[detectHomeTemplate(dir) ?? "claude"];
  return resolve(dir, "home", subdir);
}

/** Skills subdir relative to home/, e.g. ".claude/skills" */
function mindSkillsSubdir(dir: string): string {
  const home = resolve(dir, "home");
  return mindSkillsDir(dir).slice(home.length + 1);
}

/** Relative path from mind dir to skills dir, e.g. "home/.agents/skills" */
function relSkillsPath(dir: string): string {
  return join("home", mindSkillsSubdir(dir));
}

type UpstreamInfo = {
  source: string;
  version: number;
  baseCommit: string;
};

export function readUpstream(skillDir: string): UpstreamInfo | null {
  const upstreamPath = join(skillDir, ".upstream.json");
  if (!existsSync(upstreamPath)) return null;
  try {
    const data = JSON.parse(readFileSync(upstreamPath, "utf-8"));
    if (
      typeof data?.source !== "string" ||
      typeof data?.version !== "number" ||
      typeof data?.baseCommit !== "string"
    ) {
      return null;
    }
    return data as UpstreamInfo;
  } catch (err) {
    log.warn(`corrupt .upstream.json in ${skillDir}`, log.errorData(err));
    return null;
  }
}

export type InstallResult = {
  installNotes: string | null;
  npmInstalled: string[];
};

export async function installSkill(
  mindName: string,
  dir: string,
  skillId: string,
): Promise<InstallResult> {
  validateSkillId(skillId);
  const shared = await getSharedSkill(skillId);
  if (!shared) throw new Error(`Shared skill not found: ${skillId}`);

  const sourceDir = join(sharedSkillsDir(), skillId);
  if (!existsSync(sourceDir)) throw new Error(`Shared skill files not found: ${skillId}`);

  const destDir = join(mindSkillsDir(dir), skillId);
  if (existsSync(destDir)) throw new Error(`Skill already installed: ${skillId}`);

  mkdirSync(destDir, { recursive: true });
  cpSync(sourceDir, destDir, { recursive: true });

  // Parse SKILL.md once for npm dependencies, hooks, and bin
  const npmInstalled: string[] = [];
  const skillMdPath = join(sourceDir, "SKILL.md");
  if (existsSync(skillMdPath)) {
    const { npmDependencies, hooks, bin } = parseSkillMd(readFileSync(skillMdPath, "utf-8"));
    if (npmDependencies.length > 0) {
      try {
        await exec("npm", ["install", ...npmDependencies], { cwd: dir });
        npmInstalled.push(...npmDependencies);
      } catch (e) {
        // Clean up partial install so the skill can be retried
        rmSync(destDir, { recursive: true });
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(
          `Failed to install npm dependencies (${npmDependencies.join(", ")}): ${msg}`,
        );
      }
    }
    try {
      // An explicit install gives every shim, even one a previous install of
      // this skill gave and the mind then deleted.
      reconcileSkillShims(mindName, dir, skillId, { hooks, bin }, { restoreDeleted: true });
    } catch (e) {
      // Clean up partial install (copied dir + any hook shims) so a failure
      // here — e.g. a bin-shim collision with another skill — doesn't leave
      // destDir behind and wedge every retry on the "already installed" guard.
      removeHookShims(dir, skillId);
      rmSync(destDir, { recursive: true });
      throw e;
    }
  }

  // Read install notes if present
  let installNotes: string | null = null;
  const installMdPath = join(destDir, "references", "INSTALL.md");
  if (existsSync(installMdPath)) {
    installNotes = readFileSync(installMdPath, "utf-8");
  }

  // Write upstream tracking file
  // We need to commit first, then get the hash, then write upstream and amend
  await gitExec(["add", join(relSkillsPath(dir), skillId)], { cwd: dir });
  // Stage hook shim and bin command files if any were created
  await gitExec(["add", join("home", ".local", "hooks")], { cwd: dir }).catch(() => {});
  await gitExec(["add", join("home", ".local", "bin")], { cwd: dir }).catch(() => {});
  // Also commit package.json/package-lock.json changes from npm install
  if (npmInstalled.length > 0) {
    await gitExec(["add", "package.json", "package-lock.json"], { cwd: dir });
  }
  await gitExec(["commit", "-m", `Install shared skill: ${skillId}`], { cwd: dir });
  const commitHash = (await gitExec(["rev-parse", "HEAD"], { cwd: dir })).trim();

  const upstream: UpstreamInfo = {
    source: skillId,
    version: shared.version,
    baseCommit: commitHash,
  };
  writeFileSync(join(destDir, ".upstream.json"), `${JSON.stringify(upstream, null, 2)}\n`);
  await gitExec(["add", join(relSkillsPath(dir), skillId, ".upstream.json")], {
    cwd: dir,
  });
  await gitExec(["commit", "--amend", "--no-edit"], { cwd: dir });

  return { installNotes, npmInstalled };
}

export async function uninstallSkill(
  _mindName: string,
  dir: string,
  skillId: string,
): Promise<void> {
  validateSkillId(skillId);
  const skillDir = join(mindSkillsDir(dir), skillId);
  if (!existsSync(skillDir)) throw new Error(`Skill not installed: ${skillId}`);

  // Remove hook shims and bin command for this skill
  removeHookShims(dir, skillId);
  const skillMdPath = join(skillDir, "SKILL.md");
  if (existsSync(skillMdPath)) {
    const { bin } = parseSkillMd(readFileSync(skillMdPath, "utf-8"));
    if (bin) removeBinShim(dir, bin);
  }

  rmSync(skillDir, { recursive: true });
  await gitExec(["add", join(relSkillsPath(dir), skillId)], { cwd: dir });
  // Also stage hook shim and bin removals
  await gitExec(["add", join("home", ".local", "hooks")], { cwd: dir }).catch(() => {});
  await gitExec(["add", join("home", ".local", "bin")], { cwd: dir }).catch(() => {});
  await gitExec(["commit", "-m", `Uninstall skill: ${skillId}`], { cwd: dir });
}

function readSkillMd(skillDir: string): ReturnType<typeof parseSkillMd> | null {
  const skillMdPath = join(skillDir, "SKILL.md");
  return existsSync(skillMdPath) ? parseSkillMd(readFileSync(skillMdPath, "utf-8")) : null;
}

export type UpdateResult =
  | { status: "updated" }
  | { status: "up-to-date" }
  | { status: "conflict"; conflictFiles: string[] };

export async function updateSkill(
  mindName: string,
  dir: string,
  skillId: string,
): Promise<UpdateResult> {
  validateSkillId(skillId);
  const skillDir = join(mindSkillsDir(dir), skillId);
  if (!existsSync(skillDir)) throw new Error(`Skill not installed: ${skillId}`);

  const upstream = readUpstream(skillDir);
  if (!upstream) throw new Error(`No upstream tracking for skill: ${skillId}`);

  const shared = await getSharedSkill(upstream.source);
  if (!shared) throw new Error(`Shared skill no longer exists: ${upstream.source}`);

  if (shared.version <= upstream.version) {
    return { status: "up-to-date" };
  }

  const sourceDir = join(sharedSkillsDir(), upstream.source);
  if (!existsSync(sourceDir)) throw new Error(`Shared skill files missing: ${upstream.source}`);

  // A bin collision is refused before the merge touches the skill dir.
  const incomingBin = readSkillMd(sourceDir)?.bin;
  if (incomingBin) assertBinShimAvailable(dir, skillId, incomingBin);

  // Collect all files from current, base (git), and new (shared)
  const relSkillPath = join(relSkillsPath(dir), skillId);
  const currentFiles = listFilesRecursive(skillDir).filter((f) => f !== ".upstream.json");
  const newFiles = listFilesRecursive(sourceDir).filter((f) => f !== ".upstream.json");
  const allFiles = [...new Set([...currentFiles, ...newFiles])];

  const conflictFiles: string[] = [];
  const tmpBase = join(tmpdir(), `volute-merge-${process.pid}-${Date.now()}`);
  mkdirSync(tmpBase, { recursive: true });

  try {
    for (const file of allFiles) {
      const currentPath = join(skillDir, file);
      const newPath = join(sourceDir, file);
      const currentExists = existsSync(currentPath);
      const newExists = existsSync(newPath);

      if (!currentExists && newExists) {
        // New file — just copy
        const destPath = join(skillDir, file);
        mkdirSync(join(skillDir, ...file.split("/").slice(0, -1)), { recursive: true });
        cpSync(newPath, destPath);
        continue;
      }

      if (currentExists && !newExists) {
        // File deleted upstream — try to get base version
        let baseContent: string | null = null;
        try {
          baseContent = await gitExec(
            ["show", `${upstream.baseCommit}:${join(relSkillPath, file)}`],
            {
              cwd: dir,
            },
          );
        } catch {
          // File didn't exist in base — it was added locally, keep it
          continue;
        }
        // If current === base, the user didn't modify it, safe to delete
        const currentContent = readFileSync(currentPath, "utf-8");
        if (currentContent === baseContent) {
          rmSync(currentPath);
        }
        // If modified locally, keep it (user's version wins over upstream delete)
        continue;
      }

      // Both exist — 3-way merge
      let baseContent: string;
      try {
        baseContent = await gitExec(
          ["show", `${upstream.baseCommit}:${join(relSkillPath, file)}`],
          {
            cwd: dir,
          },
        );
      } catch {
        // File didn't exist at base commit — treat as empty
        baseContent = "";
      }

      const currentContent = readFileSync(currentPath, "utf-8");
      const newContent = readFileSync(newPath, "utf-8");

      // If current hasn't changed from base, just take the new version
      if (currentContent === baseContent) {
        writeFileSync(currentPath, newContent);
        continue;
      }

      // If new hasn't changed from base, keep current (user's modifications)
      if (newContent === baseContent) {
        continue;
      }

      // Both changed — need git merge-file
      const baseTmp = join(tmpBase, `${file}.base`);
      const currentTmp = join(tmpBase, `${file}.current`);
      const newTmp = join(tmpBase, `${file}.new`);
      mkdirSync(join(tmpBase, ...file.split("/").slice(0, -1)), { recursive: true });
      writeFileSync(baseTmp, baseContent);
      writeFileSync(currentTmp, currentContent);
      writeFileSync(newTmp, newContent);

      try {
        await exec("git", ["merge-file", currentTmp, baseTmp, newTmp]);
        // Clean merge — write result
        writeFileSync(currentPath, readFileSync(currentTmp, "utf-8"));
      } catch (e: unknown) {
        // git merge-file exits with 1 for conflicts, >1 for errors
        const exitCode =
          e && typeof e === "object" && "code" in e ? (e as { code: number }).code : null;
        if (exitCode === 1) {
          // Conflict — write result with markers
          writeFileSync(currentPath, readFileSync(currentTmp, "utf-8"));
          conflictFiles.push(file);
        } else {
          throw e;
        }
      }
    }
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }

  if (conflictFiles.length > 0) {
    // Don't commit — leave conflicts for the user to resolve
    return { status: "conflict", conflictFiles };
  }

  // Wire the merged skill up the way installSkill does — otherwise a mind that
  // installed it before hooks (#228) or bins (#231) existed keeps the files but
  // none of the npm deps or shims they rely on.
  const merged = readSkillMd(skillDir);
  const npmDependencies = merged?.npmDependencies ?? [];
  if (npmDependencies.length > 0) {
    try {
      await exec("npm", ["install", ...npmDependencies], { cwd: dir });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Failed to install npm dependencies (${npmDependencies.join(", ")}): ${msg}`);
    }
  }
  reconcileSkillShims(mindName, dir, skillId, merged ?? { hooks: {}, bin: null });

  // .upstream.json only moves to the new version once the merge is committed:
  // written first, a failed commit would leave the skill reading as up to date.
  await gitExec(["add", relSkillPath], { cwd: dir });
  await gitExec(["add", join("home", ".local", "hooks")], { cwd: dir }).catch(() => {});
  await gitExec(["add", join("home", ".local", "bin")], { cwd: dir }).catch(() => {});
  if (npmDependencies.length > 0) {
    await gitExec(["add", "package.json", "package-lock.json"], { cwd: dir });
  }
  // --allow-empty: a version bump need not change any file this mind tracks.
  await gitExec(
    ["commit", "--allow-empty", "-m", `Update skill: ${skillId} (v${shared.version})`],
    {
      cwd: dir,
    },
  );
  const commitHash = (await gitExec(["rev-parse", "HEAD"], { cwd: dir })).trim();

  const upstreamInfo: UpstreamInfo = {
    source: upstream.source,
    version: shared.version,
    baseCommit: commitHash,
  };
  writeFileSync(join(skillDir, ".upstream.json"), `${JSON.stringify(upstreamInfo, null, 2)}\n`);
  await gitExec(["add", join(relSkillPath, ".upstream.json")], { cwd: dir });
  await gitExec(["commit", "--amend", "--no-edit"], { cwd: dir });

  return { status: "updated" };
}

export type MindSkillInfo = {
  id: string;
  name: string;
  description: string;
  upstream: UpstreamInfo | null;
  updateAvailable: boolean;
};

export async function listMindSkills(dir: string): Promise<MindSkillInfo[]> {
  const skillsDir = mindSkillsDir(dir);
  if (!existsSync(skillsDir)) return [];

  const entries = readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  const sharedMap = new Map<string, SharedSkill>();
  for (const s of await listSharedSkills()) {
    sharedMap.set(s.id, s);
  }

  const results: MindSkillInfo[] = [];
  for (const entry of entries) {
    const skillDir = join(skillsDir, entry.name);
    const skillMdPath = join(skillDir, "SKILL.md");
    let name = entry.name;
    let description = "";

    if (existsSync(skillMdPath)) {
      const parsed = parseSkillMd(readFileSync(skillMdPath, "utf-8"));
      if (parsed.name) name = parsed.name;
      description = parsed.description;
    }

    const upstream = readUpstream(skillDir);
    let updateAvailable = false;
    if (upstream) {
      const shared = sharedMap.get(upstream.source);
      if (shared && shared.version > upstream.version) {
        updateAvailable = true;
      }
    }

    results.push({ id: entry.name, name, description, upstream, updateAvailable });
  }

  return results;
}

export async function publishSkill(
  mindName: string,
  dir: string,
  skillId: string,
): Promise<SharedSkill> {
  const skillDir = join(mindSkillsDir(dir), skillId);
  if (!existsSync(skillDir)) throw new Error(`Skill not found: ${skillId}`);

  const skillMdPath = join(skillDir, "SKILL.md");
  if (!existsSync(skillMdPath)) throw new Error(`SKILL.md not found in ${skillId}`);

  return importSkillFromDir(skillDir, mindName);
}

// --- Hook shim management ---

// hook-loader runs an event's hooks in plain `.sort()` order and gives the
// earliest ones the fullest share of the event's time budget, so the base hooks
// (`notices.ts` — the next-turn drain — first) must sort ahead of every skill.
// Digits sort before letters, so the old `50-` prefix put skill shims *first*;
// `zz-` sorts after any lowercase name. Shims are renamed on skill update.
export const HOOK_SHIM_PREFIX = "zz-";
const LEGACY_HOOK_SHIM_PREFIXES = ["50-"];

export function hookShimName(skillId: string): string {
  return `${HOOK_SHIM_PREFIX}${skillId}.sh`;
}

function shimContent(skillId: string, scriptPath: string, skillsSubdir: string): string {
  const ext = scriptPath.split(".").pop() ?? "sh";
  const skillScriptPath = `${skillsSubdir}/${skillId}/${scriptPath}`;
  if (ext === "ts") {
    return `#!/bin/bash\nexec node --import tsx ${skillScriptPath} "$@"\n`;
  }
  if (ext === "js") {
    return `#!/bin/bash\nexec node ${skillScriptPath} "$@"\n`;
  }
  return `#!/bin/bash\nexec bash ${skillScriptPath} "$@"\n`;
}

export function installHookShims(
  dir: string,
  skillId: string,
  hooks: Record<string, string>,
  skillsSubdir: string = mindSkillsSubdir(dir), // e.g. ".claude/skills"
): void {
  for (const [event, scriptPath] of Object.entries(hooks)) {
    const eventDir = join(dir, "home", ".local", "hooks", event);
    mkdirSync(eventDir, { recursive: true });
    const shimPath = join(eventDir, hookShimName(skillId));
    const content = shimContent(skillId, scriptPath, skillsSubdir);
    writeFileSync(shimPath, content, { mode: 0o755 });
  }
}

export function removeHookShims(dir: string, skillId: string): void {
  const hooksBase = join(dir, "home", ".local", "hooks");
  if (!existsSync(hooksBase)) return;

  for (const eventDir of readdirSync(hooksBase, { withFileTypes: true })) {
    if (!eventDir.isDirectory()) continue;
    for (const prefix of [HOOK_SHIM_PREFIX, ...LEGACY_HOOK_SHIM_PREFIXES]) {
      const shimPath = join(hooksBase, eventDir.name, `${prefix}${skillId}.sh`);
      if (existsSync(shimPath)) rmSync(shimPath);
    }
  }
}

// --- Bin shim management ---

// Marker line embedded in generated bin shims so we can tell which skill owns
// a `.local/bin` command and refuse to clobber another skill's shim.
const BIN_SHIM_MARKER = "# volute-skill:";

function binShimContent(skillId: string, scriptPath: string, skillsSubdir: string): string {
  const skillScriptPath = `${skillsSubdir}/${skillId}/${scriptPath}`;
  const ext = scriptPath.split(".").pop() ?? "sh";
  const header = `#!/bin/bash\n${BIN_SHIM_MARKER} ${skillId}\n`;
  if (ext === "ts") {
    return `${header}exec node --import tsx ${skillScriptPath} "$@"\n`;
  }
  if (ext === "js") {
    return `${header}exec node ${skillScriptPath} "$@"\n`;
  }
  return `${header}exec bash ${skillScriptPath} "$@"\n`;
}

/** Derive command name from script path: `scripts/dream.ts` → `dream` */
function binCommandName(scriptPath: string): string {
  return basename(scriptPath).replace(/\.[^.]+$/, "");
}

/** Read the owning skill id from an existing bin shim, or undefined if unmarked. */
function binShimOwner(shimPath: string): string | undefined {
  const line = readFileSync(shimPath, "utf-8")
    .split("\n")
    .find((l) => l.startsWith(BIN_SHIM_MARKER));
  return line?.slice(BIN_SHIM_MARKER.length).trim() || undefined;
}

export function installBinShim(
  dir: string,
  skillId: string,
  scriptPath: string,
  skillsSubdir: string = mindSkillsSubdir(dir),
): void {
  const binDir = join(dir, "home", ".local", "bin");
  mkdirSync(binDir, { recursive: true });
  const cmdName = binCommandName(scriptPath);
  const shimPath = join(binDir, cmdName);
  assertBinShimAvailable(dir, skillId, scriptPath);
  writeFileSync(shimPath, binShimContent(skillId, scriptPath, skillsSubdir), { mode: 0o755 });
}

/**
 * Refuse to overwrite a shim owned by a different skill — two skills that each
 * ship e.g. `scripts/sync.ts` must not silently clobber each other's command.
 */
function assertBinShimAvailable(dir: string, skillId: string, scriptPath: string): void {
  const cmdName = binCommandName(scriptPath);
  const shimPath = join(dir, "home", ".local", "bin", cmdName);
  if (!existsSync(shimPath)) return;
  const owner = binShimOwner(shimPath);
  if (owner && owner !== skillId) {
    throw new Error(
      `Bin command "${cmdName}" is already provided by skill "${owner}"; skill "${skillId}" cannot overwrite it`,
    );
  }
}

export function removeBinShim(dir: string, scriptPath: string): void {
  const cmdName = binCommandName(scriptPath);
  const shimPath = join(dir, "home", ".local", "bin", cmdName);
  if (existsSync(shimPath)) rmSync(shimPath);
}

// --- Shim reconciliation ---

/**
 * Where a mind's skill-shim ledger lives: every home-relative hook/bin shim path
 * Volute has ever given the mind for its skills. It does for skill shims what the
 * init ledger does for `.local/` infrastructure (#811) — it is what separates
 * "this mind never got the shim" (create it) from "this mind deleted it" (leave
 * it deleted). Kept in stateDir for the reasons `initLedgerPath` gives.
 */
function skillShimLedgerPath(mindName: string): string {
  return resolve(stateDir(mindName), "skill-shims.json");
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether `content` is byte-for-byte a shim Volute generates for `skillId` — for
 * any template's skills dir and any script, as a hook shim or a bin shim with or
 * without its owner marker. An edited or emptied shim is not: it is the mind's.
 */
function isGeneratedShim(content: string, skillId: string): boolean {
  const subdirs = Object.values(TEMPLATE_SKILLS_DIR).map(escapeRegExp).join("|");
  const marker = escapeRegExp(`${BIN_SHIM_MARKER} ${skillId}`);
  return new RegExp(
    `^#!/bin/bash\\n(?:${marker}\\n)?exec (?:node --import tsx|node|bash) (?:${subdirs})/${skillId}/[^\\s"]+ "\\$@"\\n$`,
  ).test(content);
}

/** Largest file worth reading to see whether it is a shim. */
const MAX_SHIM_BYTES = 4096;

// Reconciliation runs as the daemon — root under user isolation — over paths in a
// tree the mind controls, so nothing it does may follow a mind-planted symlink:
// a shim is read, replaced or created only as a plain file under plain dirs.

/** A shim's content, or null unless it is a small regular file (not a symlink). */
function readShim(abs: string): string | null {
  try {
    const st = lstatSync(abs);
    return st.isFile() && st.size <= MAX_SHIM_BYTES ? readFileSync(abs, "utf-8") : null;
  } catch {
    return null;
  }
}

/**
 * Whether every component from `dir` down to `dir/rel` is a real directory, never
 * a symlink — creating missing ones when `create` is set.
 */
function realDirChain(dir: string, rel: string, create: boolean): boolean {
  let cur = dir;
  for (const part of rel.split("/")) {
    cur = join(cur, part);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(cur);
    } catch {
      if (!create) return false;
      mkdirSync(cur);
      continue;
    }
    if (!st.isDirectory()) return false;
  }
  return true;
}

/** lstat-based existence: a dangling symlink "doesn't exist" but is not absent. */
function lexists(abs: string): boolean {
  try {
    lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

/** Create a shim; `wx` refuses to follow or clobber anything already at the path. */
function writeShim(abs: string, content: string): void {
  writeFileSync(abs, content, { mode: 0o755, flag: "wx" });
}

/**
 * Bring a skill's hook and bin shims in line with what its SKILL.md declares,
 * without undoing the mind's own choices about them:
 *
 * - a legacy `50-` hook shim is renamed in place, its content kept;
 * - a declared shim that is absent is created only if it was never given — in
 *   the ledger and absent means the mind deleted it (`restoreDeleted` overrides
 *   this for an explicit install);
 * - a present shim is refreshed only while it is still exactly something Volute
 *   generated — an edited or emptied one ("not this one", see hook-loader) stays;
 * - a shim for a hook or bin no longer declared is removed only if unmodified.
 *
 * Idempotent, and a few stats per skill, so it runs on every daemon start. Throws
 * before writing anything if the declared bin belongs to another skill. Returns
 * whether it changed anything on disk.
 */
export function reconcileSkillShims(
  mindName: string,
  dir: string,
  skillId: string,
  declared: { hooks: Record<string, string>; bin: string | null },
  { restoreDeleted = false }: { restoreDeleted?: boolean } = {},
): boolean {
  const home = join(dir, "home");
  const skillsSubdir = mindSkillsSubdir(dir);
  const ledgerPath = skillShimLedgerPath(mindName);
  const given = readInitLedgerFile(ledgerPath, mindName);
  let changed = false;

  // home-relative path → the content Volute would generate there now
  const wanted = new Map<string, string>();
  for (const [event, script] of Object.entries(declared.hooks)) {
    wanted.set(
      `.local/hooks/${event}/${hookShimName(skillId)}`,
      shimContent(skillId, script, skillsSubdir),
    );
  }
  if (declared.bin) {
    assertBinShimAvailable(dir, skillId, declared.bin);
    wanted.set(
      `.local/bin/${binCommandName(declared.bin)}`,
      binShimContent(skillId, declared.bin, skillsSubdir),
    );
  }

  // This skill's shims already on disk, legacy hook names renamed first.
  const present: string[] = [];
  if (realDirChain(dir, "home/.local/hooks", false)) {
    const hooksBase = join(home, ".local", "hooks");
    for (const event of readdirSync(hooksBase, { withFileTypes: true })) {
      if (!event.isDirectory()) continue;
      const current = join(hooksBase, event.name, hookShimName(skillId));
      for (const prefix of LEGACY_HOOK_SHIM_PREFIXES) {
        const legacy = join(hooksBase, event.name, `${prefix}${skillId}.sh`);
        if (!existsSync(legacy)) continue;
        if (!existsSync(current)) renameSync(legacy, current);
        else if (isGeneratedShim(readShim(legacy) ?? "", skillId)) rmSync(legacy);
        else continue;
        changed = true;
      }
      if (existsSync(current)) present.push(`.local/hooks/${event.name}/${hookShimName(skillId)}`);
    }
  }
  if (realDirChain(dir, "home/.local/bin", false)) {
    for (const f of readdirSync(join(home, ".local", "bin"))) {
      const rel = `.local/bin/${f}`;
      if (isGeneratedShim(readShim(join(home, rel)) ?? "", skillId)) present.push(rel);
    }
  }

  for (const rel of present) {
    if (wanted.has(rel)) continue;
    const abs = join(home, rel);
    if (isGeneratedShim(readShim(abs) ?? "", skillId)) {
      rmSync(abs);
      given.delete(rel);
      changed = true;
    }
  }

  for (const [rel, content] of wanted) {
    const abs = join(home, rel);
    if (lexists(abs)) {
      const current = readShim(abs);
      if (current === null) continue; // a symlink or oversized file — not a shim of ours
      if (current !== content && isGeneratedShim(current, skillId)) {
        rmSync(abs);
        writeShim(abs, content);
        changed = true;
      }
    } else if (restoreDeleted || !given.has(rel)) {
      if (!realDirChain(dir, `home/${dirname(rel)}`, true)) {
        log.warn(`not creating ${rel} for ${mindName}: a parent is not a plain directory`);
        continue;
      }
      writeShim(abs, content);
      changed = true;
    } else {
      continue; // given, then deleted by the mind
    }
    // Recorded only once the file is known to be on disk: a ledger entry for a
    // shim that never landed would read as "deleted" and withhold it forever.
    given.add(rel);
  }

  writeLedgerFile(ledgerPath, given, mindName);
  return changed;
}

// --- Template switch migration ---

/**
 * When a mind switches templates during upgrade, installed skills would otherwise
 * be stranded in the old template's skills dir — invisible to the new runtime's
 * skill discovery and to `volute skill list` (which reads the new, empty dir),
 * while their bin/hook shims keep pointing at the old path. Move each installed
 * skill directory (preserving .upstream.json) into the new template's skills dir
 * and regenerate its shims so their embedded paths match. Returns migrated ids.
 */
export function migrateSkillsToTemplate(
  dir: string,
  oldTemplate: string,
  newTemplate: string,
): string[] {
  const home = resolve(dir, "home");
  const oldSubdir = TEMPLATE_SKILLS_DIR[oldTemplate] ?? TEMPLATE_SKILLS_DIR.claude;
  const newSubdir = TEMPLATE_SKILLS_DIR[newTemplate] ?? TEMPLATE_SKILLS_DIR.claude;
  if (oldSubdir === newSubdir) return [];

  const oldDir = resolve(home, oldSubdir);
  const newDir = resolve(home, newSubdir);
  if (!existsSync(oldDir)) return [];

  const skillIds = readdirSync(oldDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const migrated: string[] = [];
  if (skillIds.length > 0) {
    mkdirSync(newDir, { recursive: true });
    for (const skillId of skillIds) {
      const from = join(oldDir, skillId);
      const to = join(newDir, skillId);
      // The new template starts with no skills, so a collision is unexpected —
      // but be safe and let the migrated copy win.
      if (existsSync(to)) rmSync(to, { recursive: true, force: true });
      renameSync(from, to);

      // Regenerate shims with the new skills subdir. The shim files live at the
      // same .local/hooks|bin paths regardless of template, so reinstalling
      // overwrites the stale ones in place.
      removeHookShims(dir, skillId);
      const skillMdPath = join(to, "SKILL.md");
      if (existsSync(skillMdPath)) {
        const { hooks, bin } = parseSkillMd(readFileSync(skillMdPath, "utf-8"));
        installHookShims(dir, skillId, hooks, newSubdir);
        if (bin) installBinShim(dir, skillId, bin, newSubdir);
      }
      migrated.push(skillId);
    }
  }

  // Remove the now-empty old skills dir so marker-based detection stays clean.
  rmSync(oldDir, { recursive: true, force: true });
  return migrated;
}

// --- Helpers ---

export function listFilesRecursive(dir: string, prefix = ""): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(join(dir, entry.name), rel));
    } else {
      results.push(rel);
    }
  }
  return results;
}

// --- Built-in skill sync ---

/**
 * Find the skills/ root directory by walking up from the calling module's location.
 * Same pattern as findTemplatesRoot() in template.ts.
 */
let _skillsRoot: string | null = null;
export function findSkillsRoot(): string {
  if (_skillsRoot) return _skillsRoot;
  let dir = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(dir, "skills");
    if (existsSync(candidate) && hasSkillSubdir(candidate)) {
      _skillsRoot = candidate;
      return _skillsRoot;
    }
    dir = dirname(dir);
  }
  throw new Error("Skills directory not found");
}

/** Check that a directory contains at least one subdirectory with a SKILL.md file. */
function hasSkillSubdir(dir: string): boolean {
  return readdirSync(dir, { withFileTypes: true }).some(
    (e) => e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md")),
  );
}

/**
 * SHA-256 hash of all file contents in a directory for change detection.
 */
export function hashSkillDir(dir: string): string {
  const hash = createHash("sha256");
  const files = listFilesRecursive(dir).sort();
  for (const file of files) {
    hash.update(file);
    hash.update(readFileSync(join(dir, file)));
  }
  return hash.digest("hex");
}

/** Whether auto-update is enabled (defaults to true). */
export function isAutoUpdateSkillsEnabled(): boolean {
  return readGlobalConfig().autoUpdateSkills !== false;
}

/**
 * Auto-update skills for all minds that have outdated upstream-tracked skills.
 * Skips minds with conflicts or errors (non-fatal).
 */
export async function autoUpdateMindSkills(): Promise<void> {
  const baseMinds = await readRegistry();
  const shared = await listSharedSkills();
  const sharedMap = new Map(shared.map((s) => [s.id, s]));

  for (const mind of baseMinds) {
    const dir = mind.dir ?? mindDir(mind.name);
    const skillsDir = mindSkillsDir(dir);
    if (!existsSync(skillsDir)) continue;

    const entries = readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory());

    let wrote = false;
    for (const entry of entries) {
      const upstream = readUpstream(join(skillsDir, entry.name));
      if (!upstream) continue;

      const sharedSkill = sharedMap.get(upstream.source);
      if (!sharedSkill || sharedSkill.version <= upstream.version) {
        // Current skills still get their shims reconciled: an update is the only
        // other thing that does it, so a skill installed before hooks/bins existed
        // (or carrying a legacy `50-` shim) would otherwise wait for a version bump.
        try {
          const declared = readSkillMd(join(skillsDir, entry.name));
          if (declared && reconcileSkillShims(mind.name, dir, entry.name, declared)) wrote = true;
        } catch (err) {
          log.warn(
            `failed to reconcile shims for skill ${entry.name} in ${mind.name}`,
            log.errorData(err),
          );
        }
        continue;
      }

      wrote = true;
      try {
        const result = await updateSkill(mind.name, dir, entry.name);
        if (result.status === "updated") {
          log.info(`auto-updated skill ${entry.name} for ${mind.name} (v${sharedSkill.version})`);
        } else if (result.status === "conflict") {
          log.warn(
            `auto-update conflict for skill ${entry.name} in ${mind.name}: ${result.conflictFiles.join(", ")}`,
          );
        }
      } catch (err) {
        log.error(`failed to auto-update skill ${entry.name} for ${mind.name}`, log.errorData(err));
      }
    }
    // Updates and reconciles write as the daemon (root under user isolation) —
    // hand everything back, even after a failure part-way through.
    if (wrote) {
      await chownMindDir(dir, mind.name).catch((err) =>
        log.error(`failed to chown ${mind.name} after skill updates`, log.errorData(err)),
      );
    }
  }
}

/**
 * Sync built-in skills from the repo's skills/ directory into the shared pool.
 * Only imports when content has changed (via hash comparison).
 */
export async function syncBuiltinSkills(): Promise<void> {
  let skillsRoot: string;
  try {
    skillsRoot = findSkillsRoot();
  } catch {
    log.warn("built-in skills directory not found, skipping sync");
    return;
  }

  const entries = readdirSync(skillsRoot, { withFileTypes: true }).filter((e) => e.isDirectory());

  for (const entry of entries) {
    const sourceDir = join(skillsRoot, entry.name);
    if (!existsSync(join(sourceDir, "SKILL.md"))) continue;

    try {
      const sourceHash = hashSkillDir(sourceDir);

      // Skip only when the shared pool already has this version on disk AND the
      // DB row exists — the DB is what listSharedSkills() (and the UI) reads. If
      // they ever diverge (e.g. the DB is reset but the on-disk pool survives),
      // re-import so the row is repopulated rather than silently missing.
      const destDir = join(sharedSkillsDir(), entry.name);
      if (existsSync(destDir)) {
        const destHash = hashSkillDir(destDir);
        if (sourceHash === destHash && (await getSharedSkill(entry.name))) continue;
      }

      await importSkillFromDir(sourceDir, "volute");
      log.info(`synced built-in skill: ${entry.name}`);
    } catch (err) {
      log.error(`failed to sync built-in skill: ${entry.name}`, log.errorData(err));
    }
  }
}
