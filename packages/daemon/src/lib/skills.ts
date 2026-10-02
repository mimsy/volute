import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  fchmodSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { MIND_LEVEL_THREAD, recordNotice } from "./chat/system-events.js";
import { readGlobalConfig, writeGlobalConfig } from "./config/setup.js";
import { getDb } from "./db.js";
import { readInitLedgerFile, writeLedgerFile } from "./mind/init-ledger.js";
import { chownMindDir, mindFileOwner, mindGitOpts, reclaimMindGit } from "./mind/isolation.js";
import {
  ensureMindDir,
  type MindFileOwner,
  MindFileRefusedError,
  MindFileTooLargeError,
  readMindFile,
  readMindFileBytes,
  readMindFileSync,
  removeMindFile,
  resolveMindDir,
  writeMindFile,
} from "./mind/mind-file-write.js";
import { npmInstallAsMind } from "./mind/npm-install.js";
import { getBaseName, mindDir, readRegistry, stateDir, voluteHome } from "./mind/registry.js";
import { sharedSkills } from "./schema.js";
import { exec, gitExec } from "./util/exec.js";
import log from "./util/logger.js";
import { buildMindBaseEnv } from "./util/mind-env.js";
import { PathTraversalError } from "./util/paths.js";

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

/**
 * Import a skill into the shared pool. `untrusted` is for content someone else wrote (a
 * mind's skill, staged out of its tree by publishSkill; an upload): it must hold only
 * directories and plain files — a link, a hard link to a file elsewhere, or a FIFO refuses
 * the whole import — since the pool's later readers would follow it and hand its target to
 * every installer. It is checked, not raced: neither source is in a tree its author can
 * still change. Trusted sources (built-ins, extensions) may be hard-linked by their package
 * manager. `id` defaults to the source dir's name.
 */
export async function importSkillFromDir(
  sourceDir: string,
  author: string,
  opts: { untrusted?: boolean } = {},
): Promise<SharedSkill> {
  const skillMdPath = join(sourceDir, "SKILL.md");
  if (!existsSync(skillMdPath)) {
    throw new Error("SKILL.md not found in source directory");
  }

  if (opts.untrusted) assertPlainTree(sourceDir);
  const content = opts.untrusted
    ? readMindFileSync(skillMdPath)
    : readFileSync(skillMdPath, "utf-8");
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
  /** A commit holding the skill exactly as upstream shipped `version` — the merge base. */
  baseCommit: string;
  /** The newer version the mind was last told is waiting on its unresolved markers. */
  conflictNotified?: number;
};

/**
 * git in a mind's repo, as the mind (#1284). Run as the daemon — root under user isolation —
 * git runs whatever the mind's `.git/config` names: hooks, `core.fsmonitor`, but also a
 * `filter.<driver>.clean` on an add and `gpg.program` on a commit, which no `-c` can switch
 * off for a driver it can't name. As the mind they run with the mind's own privilege, and
 * the objects git writes are the mind's, so nothing under its .git is left root-owned.
 */
export function mindGit(
  dir: string,
  mindName: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; stdin?: string | Buffer } = {},
): Promise<string> {
  const base = mindGitOpts(dir, mindName);
  const env = base.env || opts.env ? { ...base.env, ...opts.env } : undefined;
  return gitExec(args, { ...base, env, stdin: opts.stdin });
}

/**
 * A commit as the mind needs an identity of the mind's: a repo that has none (the spirit's,
 * whose history the daemon began; a mind old enough to predate repo identities) gets the
 * one creation gives, rather than the commit failing on the daemon's identity being gone.
 */
async function ensureCommitIdentity(dir: string, mindName: string): Promise<void> {
  const email = await mindGit(dir, mindName, ["config", "user.email"]).catch(() => "");
  if (email.trim()) return;
  // Dynamic: upgrade.ts imports this module.
  const { configureGitIdentity } = await import("./mind/upgrade.js");
  await configureGitIdentity(mindName, mindGitOpts(dir, mindName));
}

/**
 * Git plumbing has no reason to run anything the mind configured — no fsmonitor command,
 * no hooks (update-ref's reference-transaction) — even as the mind.
 */
const PLUMBING = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "log.showSignature=false",
];

/**
 * Record the pool's copy of a skill as a commit in the mind's repo, at the skill's path,
 * and return it: the base for the next 3-way merge has to be what upstream shipped, not the
 * mind's merged result — against that, the mind's own edits read as changes upstream "made"
 * and the next update takes the new version over them (#1277). Built in a scratch index so
 * HEAD and the working tree are untouched, and kept reachable under its own
 * {@link upstreamRef} — one per version, so a variant's worktree (which shares refs) or a
 * failed install recording another version never leaves this one to gc.
 */
async function recordUpstreamBase(
  dir: string,
  mindName: string,
  relSkillPath: string,
  sourceDir: string,
  skillId: string,
  version: number,
): Promise<string> {
  const git = (args: string[], opts?: { env?: NodeJS.ProcessEnv; stdin?: string | Buffer }) =>
    mindGit(dir, mindName, [...PLUMBING, ...args], opts);
  const files = listFilesRecursive(sourceDir).filter((f) => f !== ".upstream.json");
  // The bytes go to the mind's git on stdin, so the pool need not be readable by it — read
  // through readPoolFile, which refuses a link a mind got into the pool before publishes
  // were vetted, so its target never reaches the mind's repo.
  const lines: string[] = [];
  for (const f of files) {
    const src = join(sourceDir, f);
    const sha = (
      await git(["hash-object", "-w", "--no-filters", "--stdin"], { stdin: readPoolFile(src) })
    ).trim();
    const mode = lstatSync(src).mode & 0o111 ? "100755" : "100644";
    lines.push(`${mode} ${sha}\t${join(relSkillPath, f)}\n`);
  }
  // The scratch index lives in the mind's own git dir (a worktree's, for a variant), and
  // is written and removed only as the mind — the daemon never touches it.
  const index = resolve(
    dir,
    (await git(["rev-parse", "--git-path", `volute-skill-base-${randomUUID()}.index`])).trim(),
  );
  try {
    const env = { GIT_INDEX_FILE: index };
    await git(["read-tree", "--empty"], { env });
    await git(["update-index", "--add", "--index-info"], { env, stdin: lines.join("") });
    const tree = (await git(["write-tree"], { env })).trim();
    await ensureCommitIdentity(dir, mindName);
    const commit = (
      await git(["commit-tree", "--no-gpg-sign", tree, "-m", UPSTREAM_SUBJECT(skillId, version)])
    ).trim();
    await git(["update-ref", upstreamRef(skillId, version), commit]);
    return commit;
  } finally {
    await exec("rm", ["-f", "--", index], { mindName }).catch((err) =>
      log.warn(`failed to remove ${index}`, log.errorData(err)),
    );
  }
}

const UPSTREAM_SUBJECT = (skillId: string, version: number) =>
  `Upstream skill: ${skillId} (v${version})`;

/** A full object name — what .upstream.json records; anything else names nothing here. */
const OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Where {@link recordUpstreamBase} keeps its copy of `version` reachable. */
const upstreamRef = (skillId: string, version: number) =>
  `refs/volute/skill-upstream/${skillId}/v${version}`;

/** The commit {@link upstreamRef} points at, or "" when there is none. */
async function recordedBaseRef(
  dir: string,
  mindName: string,
  skillId: string,
  version: number,
): Promise<string> {
  const ref = upstreamRef(skillId, version);
  return (
    await mindGit(dir, mindName, [...PLUMBING, "rev-parse", "--verify", "-q", ref]).catch(() => "")
  ).trim();
}

/** Whether `commit` is {@link recordUpstreamBase}'s copy of exactly `version`. */
async function isUpstreamCopyOf(
  dir: string,
  mindName: string,
  commit: string,
  skillId: string,
  version: number,
): Promise<boolean> {
  if (!OBJECT_NAME.test(commit)) return false;
  const subject = await mindGit(dir, mindName, [
    ...PLUMBING,
    "log",
    "-1",
    "--format=%s",
    commit,
  ]).catch(() => "");
  return subject.trim() === UPSTREAM_SUBJECT(skillId, version);
}

/**
 * The base to merge against: upstream's own copy of the version the skill is at, or the
 * closest thing to it that can't make a mind's edit read as upstream's.
 *
 * 1. The commit .upstream.json names, when {@link recordUpstreamBase} made it for this
 *    version — known by its subject, not by a ref, which a variant's worktree shares.
 * 2. The copy kept under {@link upstreamRef} for this version: what an import's foreign
 *    base (#1299), an update recorded by an older daemon or an amended-away install base
 *    gets from {@link recordMissingSkillBases}.
 * 3. The commit that installed the skill — a pure upstream copy, older, so the merge may
 *    conflict, but it never reverts the mind's edits. An older daemon's update recorded its
 *    merged result instead (#1277); that is never a base, since its "Update skill" commit
 *    may hold edits the mind had not committed yet.
 * 4. Otherwise none (null): only what the mind and upstream already agree on merges cleanly.
 */
async function mergeBaseFor(
  dir: string,
  mindName: string,
  skillId: string,
  upstream: UpstreamInfo,
): Promise<string | null> {
  const recorded = upstream.baseCommit;
  if (await isUpstreamCopyOf(dir, mindName, recorded, skillId, upstream.version)) return recorded;
  const refBase = await recordedBaseRef(dir, mindName, skillId, upstream.version);
  if (refBase && (await isUpstreamCopyOf(dir, mindName, refBase, skillId, upstream.version))) {
    return refBase;
  }
  const installed = (
    await mindGit(dir, mindName, [
      ...PLUMBING,
      "log",
      "-1",
      "--format=%H",
      `--grep=^Install shared skill: ${skillId}$`,
    ]).catch(() => "")
  ).trim();
  if (installed) return installed;
  // An install commit HEAD no longer reaches but this repo still has (an amend's original).
  const subject = OBJECT_NAME.test(recorded)
    ? await mindGit(dir, mindName, [...PLUMBING, "log", "-1", "--format=%s", recorded]).catch(
        () => "",
      )
    : "";
  return subject.trim() === `Install shared skill: ${skillId}` ? recorded : null;
}

/**
 * Give every installed skill an exact copy of the version it is at under its
 * {@link upstreamRef}, while the pool still holds that version — for the skills whose
 * .upstream.json names no such copy. Those are an imported mind's (#1299: its archive
 * carries .upstream.json but no .git, and no install commit to fall back on, so its first
 * update would merge against nothing and hand it conflict markers for edits it never
 * made), and a native one whose base an older daemon recorded — its merged result, or an
 * install commit it then amended away — which would otherwise fall back to the install
 * commit and conflict more than it must. Runs at daemon start, before any pool sync —
 * built-in or extension — can move the pool past that version; once one has, that
 * version's bytes are gone from the host.
 *
 * As the mind, it writes objects and refs only; .upstream.json and the branch are left
 * alone, and {@link mergeBaseFor} finds the copy by the ref. One git per mind once every
 * skill has its ref.
 */
export async function recordMissingSkillBases(): Promise<void> {
  const pool = new Map((await listSharedSkills()).map((s) => [s.id, s]));
  for (const mind of await readRegistry()) {
    const dir = mind.dir ?? mindDir(mind.name);
    const skillsDir = mindSkillsDir(dir);
    if (!existsSync(join(dir, ".git")) || !existsSync(skillsDir)) continue;
    const scan = () => {
      const found: { id: string; upstream: UpstreamInfo; sourceDir: string }[] = [];
      for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const upstream = readUpstream(join(skillsDir, entry.name));
        if (!upstream || pool.get(upstream.source)?.version !== upstream.version) continue;
        const sourceDir = join(sharedSkillsDir(), upstream.source);
        if (existsSync(sourceDir)) found.push({ id: entry.name, upstream, sourceDir });
      }
      return found;
    };
    try {
      // Read-only first: a mind with nothing to record takes no lock and no git.
      if (scan().length === 0) continue;
      await withSkillsLock(mind.name, async () => {
        const candidates = scan();
        if (candidates.length === 0) return;
        const refs = new Set(
          (
            await mindGit(dir, mind.name, [
              ...PLUMBING,
              "for-each-ref",
              "--format=%(refname)",
              "refs/volute/skill-upstream/",
            ])
          )
            .split("\n")
            .filter(Boolean),
        );
        let reclaimed = false;
        for (const { id, upstream, sourceDir } of candidates) {
          const ref = upstreamRef(id, upstream.version);
          if (refs.has(ref)) continue;
          // Only a mind with a base still to write pays for the walk.
          if (!reclaimed) {
            reclaimed = true;
            await reclaimGitForSkills(dir, mind.name);
          }
          if (await isUpstreamCopyOf(dir, mind.name, upstream.baseCommit, id, upstream.version)) {
            // Recorded before refs were per version: keep it reachable under its own.
            await mindGit(dir, mind.name, [...PLUMBING, "update-ref", ref, upstream.baseCommit]);
            continue;
          }
          await recordUpstreamBase(
            dir,
            mind.name,
            join(relSkillsPath(dir), id),
            sourceDir,
            id,
            upstream.version,
          );
          log.info(`recorded the upstream base of skill ${id} for ${mind.name}`);
        }
      });
    } catch (err) {
      log.warn(`failed to record missing skill bases for ${mind.name}`, log.errorData(err));
    }
  }
}

/** Markers this code wrote (`yours`), or an older daemon's (named after its temp dir). */
const MERGE_MARKER = /^<<<<<<< (?:yours$|.*volute-merge-)/m;

export function readUpstream(skillDir: string): UpstreamInfo | null {
  const upstreamPath = join(skillDir, ".upstream.json");
  if (!existsSync(upstreamPath)) return null;
  try {
    // The mind owns this file: no following a link at it, no blocking on a FIFO.
    const data = JSON.parse(readMindFileSync(upstreamPath));
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

/**
 * A refusal to touch something a mind planted: a walk out of its tree, a link, a FIFO, a
 * hard link (O_NOFOLLOW at the name surfaces as a bare ELOOP).
 */
function isRefusal(err: unknown): boolean {
  return (
    err instanceof MindFileRefusedError ||
    err instanceof PathTraversalError ||
    (err as NodeJS.ErrnoException)?.code === "ELOOP"
  );
}

/** Refuse anything but a directory or a regular file with a single link. */
function assertPlainEntry(path: string): void {
  const st = lstatSync(path);
  if (!st.isDirectory() && !(st.isFile() && st.nlink === 1)) {
    throw new MindFileRefusedError(
      `refusing ${path}: not a directory or a regular file with a single link`,
    );
  }
}

function assertPlainTree(dir: string): void {
  assertPlainEntry(dir);
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    assertPlainEntry(path);
    if (lstatSync(path).isDirectory()) assertPlainTree(path);
  }
}

/** Read a file from the shared pool, refusing anything but a plain file. */
function readPoolFile(path: string): Buffer {
  const st = lstatSync(path);
  if (!st.isFile() || st.nlink !== 1) {
    throw new MindFileRefusedError(`refusing ${path}: not a regular file with a single link`);
  }
  return readFileSync(path);
}

/**
 * Copy a skill from the pool into a mind, file by file through {@link writeMindFile}: every
 * directory on the way is walked (a link out of the mind refuses) and created as the
 * mind's, and every file is opened without following a link — so a dir the mind swaps for
 * a link once the copy has started refuses rather than redirecting the daemon's writes (up
 * to the resolve-to-open race mind-file-write.ts names). Modes are kept (scripts may be
 * executable).
 */
export async function copySkillTree(
  sourceDir: string,
  dir: string,
  relDest: string,
  owner: MindFileOwner | null,
): Promise<void> {
  for (const file of listFilesRecursive(sourceDir)) {
    const src = join(sourceDir, file);
    await writeMindFile(dir, join(relDest, file), readPoolFile(src), {
      owner,
      mode: lstatSync(src).mode & 0o777,
    });
  }
}

/**
 * Remove a directory in a mind: its parent is re-contained first (a link out of the mind
 * refuses), and a link at the name is removed itself — never what it points at, which may
 * be the mind's own work elsewhere in its tree.
 *
 * A recursive rm walks by path, and the mind can rearrange its tree under it: swap a
 * subdirectory for a link mid-walk, or hold a cwd or open dir inside it (a rename moves the
 * tree but revokes neither). Under user isolation the daemon is root, so that walk runs as
 * the mind's uid — it can then delete only what the mind could delete itself. Without
 * isolation (sandbox mode, or none) the daemon runs as the host user the minds also run
 * as, so there is no root to escalate to: the walk runs in-process. (Under sandbox that
 * user's reach is wider than the sandboxed mind's — the same narrow walk race, by the same
 * uid, not a privilege gain.)
 */
async function removeMindTree(dir: string, rel: string, owner: MindFileOwner | null) {
  const parent = await resolveMindDir(dir, dirname(rel), owner);
  if (!parent) return;
  const target = join(parent, basename(rel));
  if (!owner) {
    await rm(target, { recursive: true, force: true });
    return;
  }
  await new Promise<void>((resolveRm, rejectRm) =>
    execFile(
      "rm",
      ["-rf", "--", target],
      { uid: owner.uid, gid: owner.gid, env: buildMindBaseEnv() },
      (err) => (err ? rejectRm(err) : resolveRm()),
    ),
  );
}

/** Remove an installed skill's directory from a mind ({@link removeMindTree}). */
export async function removeSkillDir(dir: string, skillDir: string, owner: MindFileOwner | null) {
  await removeMindTree(dir, relative(dir, skillDir), owner);
}

/**
 * Skill operations on one mind — and its variants, whose worktrees share its git dir —
 * one at a time, so two never interleave their adds and commits or their recorded bases.
 */
const skillsLocks = new Map<string, Promise<unknown>>();

async function withSkillsLock<T>(mindName: string, fn: () => Promise<T>): Promise<T> {
  const key = await getBaseName(mindName);
  const run = (skillsLocks.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  skillsLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (skillsLocks.get(key) === tail) skillsLocks.delete(key);
  }
}

/**
 * Skills git runs as the mind, so before a skills operation writes to the mind's repo it
 * hands the mind any root-owned entry in its .git (#1310). Only then — the walk is I/O a
 * slow disk feels at every start. Best-effort: a git the reclaim couldn't help still
 * fails with its own error.
 */
async function reclaimGitForSkills(dir: string, mindName: string): Promise<void> {
  await reclaimMindGit(dir, mindName).catch((err) =>
    log.warn(`failed to reclaim ${mindName}'s .git before skills git`, log.errorData(err)),
  );
}

export function installSkill(
  mindName: string,
  dir: string,
  skillId: string,
): Promise<InstallResult> {
  return withSkillsLock(mindName, () => installSkillLocked(mindName, dir, skillId));
}

async function installSkillLocked(
  mindName: string,
  dir: string,
  skillId: string,
): Promise<InstallResult> {
  validateSkillId(skillId);
  const shared = await getSharedSkill(skillId);
  if (!shared) throw new Error(`Shared skill not found: ${skillId}`);

  const sourceDir = join(sharedSkillsDir(), skillId);
  if (!existsSync(sourceDir)) throw new Error(`Shared skill files not found: ${skillId}`);
  await reclaimGitForSkills(dir, mindName);

  const destDir = join(mindSkillsDir(dir), skillId);
  if (lexists(destDir)) throw new Error(`Skill already installed: ${skillId}`);

  // The skills dir is the mind's, and the daemon may be root: copy through the mind-file
  // helpers, so nothing the mind plants on the way can aim a write elsewhere.
  const owner = await mindFileOwner(await getBaseName(mindName));
  // A cleanup that fails (a refusal over something the mind planted) is logged, never
  // thrown: the error that made the install fail is the one its caller needs.
  const cleanupFailed = (err: unknown) =>
    log.warn(
      `failed to clean up a partial install of ${skillId} in ${mindName}`,
      log.errorData(err),
    );
  try {
    await copySkillTree(sourceDir, dir, relative(dir, destDir), owner);
  } catch (e) {
    // A partial copy would wedge every retry on the "already installed" guard.
    await removeSkillDir(dir, destDir, owner).catch(cleanupFailed);
    throw e;
  }

  // Parse SKILL.md once for npm dependencies, hooks, and bin
  const npmInstalled: string[] = [];
  const skillMdPath = join(sourceDir, "SKILL.md");
  let declaredBin: string | null = null;
  // lexists, not existsSync: a dangling link in the pool must reach readPoolFile and refuse.
  if (lexists(skillMdPath)) {
    const { npmDependencies, hooks, bin } = parseSkillMd(readPoolFile(skillMdPath).toString());
    if (npmDependencies.length > 0) {
      try {
        await npmInstallAsMind(dir, mindName, npmDependencies);
        npmInstalled.push(...npmDependencies);
      } catch (e) {
        // Clean up partial install so the skill can be retried
        await removeSkillDir(dir, destDir, owner).catch(cleanupFailed);
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
      try {
        removeHookShims(dir, skillId);
      } catch (err) {
        cleanupFailed(err);
      }
      await removeSkillDir(dir, destDir, owner).catch(cleanupFailed);
      throw e;
    }
    declaredBin = bin;
  }

  // Read install notes if present — from the pool: the mind's copy is the mind's to relink
  let installNotes: string | null = null;
  const installMdPath = join(sourceDir, "references", "INSTALL.md");
  if (lexists(installMdPath)) {
    installNotes = readPoolFile(installMdPath).toString();
  }

  const relSkillPath = join(relSkillsPath(dir), skillId);
  const git = (args: string[]) => mindGit(dir, mindName, args);
  try {
    // The base the first update merges against: the pool's copy, as its own commit, kept
    // reachable under refs/volute/ — never a commit an amend leaves to gc.
    const upstream: UpstreamInfo = {
      source: skillId,
      version: shared.version,
      baseCommit: await recordUpstreamBase(
        dir,
        mindName,
        relSkillPath,
        sourceDir,
        skillId,
        shared.version,
      ),
    };
    await writeMindFile(
      dir,
      relative(dir, join(destDir, ".upstream.json")),
      `${JSON.stringify(upstream, null, 2)}\n`,
      { owner },
    );
    await git(["add", relSkillPath]);
    // Stage hook shim and bin command files if any were created
    await git(["add", join("home", ".local", "hooks")]).catch(() => {});
    await git(["add", join("home", ".local", "bin")]).catch(() => {});
    // Also commit package.json/package-lock.json changes from npm install
    if (npmInstalled.length > 0) {
      await git(["add", "package.json", "package-lock.json"]);
    }
    await ensureCommitIdentity(dir, mindName);
    await git(["commit", "-m", `Install shared skill: ${skillId}`]);
  } catch (e) {
    // Uncommitted, the copy would wedge every retry on the "already installed" guard.
    try {
      removeHookShims(dir, skillId);
      if (declaredBin) removeBinShim(dir, declaredBin);
    } catch (err) {
      cleanupFailed(err);
    }
    await removeSkillDir(dir, destDir, owner).catch(cleanupFailed);
    // Unstage whatever the attempt staged: the paths' index entries go back to HEAD's.
    await git([
      "reset",
      "-q",
      "--",
      relSkillPath,
      join("home", ".local", "hooks"),
      join("home", ".local", "bin"),
    ]).catch(cleanupFailed);
    throw e;
  }

  return { installNotes, npmInstalled };
}

export function uninstallSkill(mindName: string, dir: string, skillId: string): Promise<void> {
  return withSkillsLock(mindName, () => uninstallSkillLocked(mindName, dir, skillId));
}

async function uninstallSkillLocked(mindName: string, dir: string, skillId: string): Promise<void> {
  validateSkillId(skillId);
  const skillDir = join(mindSkillsDir(dir), skillId);
  if (!existsSync(skillDir)) throw new Error(`Skill not installed: ${skillId}`);
  await reclaimGitForSkills(dir, mindName);

  // The skill dir is the mind's: read and remove it through the mind-file walk, so a
  // skills dir linked out of the mind refuses instead of aiming a root rm elsewhere.
  // A SKILL.md the walk refuses (a link, a FIFO, a dir linked out of the mind) only costs
  // the bin shim's removal; the skill itself still goes.
  const owner = await mindFileOwner(await getBaseName(mindName));
  const skillMd = await readMindFile(dir, relative(dir, join(skillDir, "SKILL.md")), {
    owner,
  }).catch((err) => {
    if (isRefusal(err)) return null;
    throw err;
  });

  // Remove hook shims and bin command for this skill
  removeHookShims(dir, skillId);
  if (skillMd) {
    const { bin } = parseSkillMd(skillMd.text);
    if (bin) removeBinShim(dir, bin);
  }

  await removeSkillDir(dir, skillDir, owner);
  const git = (args: string[]) => mindGit(dir, mindName, args);
  await git(["add", join(relSkillsPath(dir), skillId)]);
  // Also stage hook shim and bin removals
  await git(["add", join("home", ".local", "hooks")]).catch(() => {});
  await git(["add", join("home", ".local", "bin")]).catch(() => {});
  await ensureCommitIdentity(dir, mindName);
  await git(["commit", "-m", `Uninstall skill: ${skillId}`]);
}

/**
 * A skill's parsed SKILL.md, or null when it has none. A mind's (and a pool entry a mind
 * published) is read without following a link or blocking on a FIFO — the daemon reads
 * these at startup, and a hung read would hang it. Throws on such a file.
 */
function readSkillMd(skillDir: string): ReturnType<typeof parseSkillMd> | null {
  try {
    return parseSkillMd(readMindFileSync(join(skillDir, "SKILL.md")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export type UpdateResult =
  | { status: "updated" }
  | { status: "up-to-date" }
  | { status: "conflict"; conflictFiles: string[] };

export function updateSkill(mindName: string, dir: string, skillId: string): Promise<UpdateResult> {
  return withSkillsLock(mindName, () => updateSkillLocked(mindName, dir, skillId));
}

async function updateSkillLocked(
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

  // The skill dir is the mind's, and the daemon may be root: every read and write in it
  // goes through the mind-file helpers, so a link or FIFO the mind planted refuses (and
  // aborts the update) instead of aiming the merge at a file elsewhere.
  const owner = await mindFileOwner(await getBaseName(mindName));
  const inSkill = (file: string) => relative(dir, join(skillDir, file));
  // Skill files have no size limit of their own; the cap only bounds the read.
  const readCurrent = async (file: string) =>
    (await readMindFileBytes(dir, inSkill(file), { owner, maxBytes: 64 * 1024 * 1024 }))?.toString(
      "utf-8",
    ) ?? null;
  const writeCurrent = (file: string, content: string | Buffer, mode?: number) =>
    writeMindFile(dir, inSkill(file), content, { owner, mode });
  // The mind's SKILL.md through the anchored walk (a skills dir linked out of the mind
  // refuses). Read once before the merge writes anything, so one that can't be read fails
  // the update before it starts rather than after half of it.
  const readMindSkillMd = async () => {
    const md = await readMindFile(dir, inSkill("SKILL.md"), { owner });
    return md ? parseSkillMd(md.text) : null;
  };
  await readMindSkillMd();
  const writeUpstream = (info: UpstreamInfo) =>
    writeCurrent(".upstream.json", `${JSON.stringify(info, null, 2)}\n`);
  const skillPaths = (files: string[]) =>
    files.map((f) => join(mindSkillsSubdir(dir), skillId, f)).join(", ");

  // Markers from an earlier conflict still unresolved: merging over them would nest them.
  // Wait for the mind, and tell it — once per version that is waiting — that one is.
  const unresolved: string[] = [];
  for (const file of currentFiles) {
    if (MERGE_MARKER.test((await readCurrent(file)) ?? "")) unresolved.push(file);
  }
  if (unresolved.length > 0) {
    if (upstream.conflictNotified !== shared.version) {
      await writeUpstream({ ...upstream, conflictNotified: shared.version });
      await notifySkillConflict(
        mindName,
        skillId,
        `Your ${skillId} skill still has unresolved conflict markers in ${skillPaths(unresolved)}, so v${shared.version} is waiting. Choose what to keep, remove the markers and commit; v${shared.version} merges on the next update (\`volute skill update ${skillId}\`, or the next daemon start).`,
      );
    }
    return { status: "conflict", conflictFiles: unresolved };
  }

  await reclaimGitForSkills(dir, mindName);
  const git = (args: string[]) => mindGit(dir, mindName, args);
  const base = await mergeBaseFor(dir, mindName, skillId, upstream);
  /** A file's base content, or null if the base has no such file (or there is no base). */
  // cat-file, not show: a blob as stored, never through a textconv the mind configured.
  const baseOf = (file: string) =>
    base === null
      ? Promise.resolve(null)
      : git([...PLUMBING, "cat-file", "blob", `${base}:${join(relSkillPath, file)}`]).catch(
          () => null,
        );
  // Recorded before anything is written, so a failure here (a git dir the mind can't
  // write to, #1310) leaves the skill as it was. A copy recorded for an update that then
  // fails is harmless: its ref is this version's, and the retry looks up only the
  // version .upstream.json still names.
  const info: UpstreamInfo = {
    source: upstream.source,
    version: shared.version,
    baseCommit: await recordUpstreamBase(
      dir,
      mindName,
      relSkillPath,
      sourceDir,
      skillId,
      shared.version,
    ),
  };
  const conflictFiles: string[] = [];
  // Unpredictable, and root's: a fixed name in a world-writable tmp could be pre-planted.
  const tmpBase = mkdtempSync(join(tmpdir(), "volute-merge-"));

  try {
    for (const file of allFiles) {
      const currentPath = join(skillDir, file);
      const newPath = join(sourceDir, file);
      const currentExists = lexists(currentPath);
      // lexists: a dangling link in the pool is not "deleted upstream" — readPoolFile refuses it.
      const newExists = lexists(newPath);

      if (!currentExists && newExists) {
        // New file — just copy (keeping its mode: skill scripts may be executable)
        await writeCurrent(file, readPoolFile(newPath), lstatSync(newPath).mode & 0o777);
        continue;
      }

      if (currentExists && !newExists) {
        // File deleted upstream. Not in the base: added locally, keep it. Unmodified from
        // the base: safe to delete. Modified locally: the mind's version wins.
        const current = await readCurrent(file);
        if (current === (await baseOf(file))) {
          await removeMindFile(dir, inSkill(file), { owner });
        }
        continue;
      }

      // Both exist — 3-way merge (a file the base lacks merges against empty)
      const currentContent = (await readCurrent(file)) ?? "";
      const baseContent = (await baseOf(file)) ?? "";
      const newContent = readPoolFile(newPath).toString();

      // If current hasn't changed from base, just take the new version
      if (currentContent === baseContent) {
        await writeCurrent(file, newContent);
        continue;
      }

      // If new hasn't changed from base, keep current (user's modifications) — and if
      // the two already agree, there is nothing to merge, base or none.
      if (newContent === baseContent || newContent === currentContent) {
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
        // Run from inside tmpBase with discovery stopped there, so no repository (a .git a
        // mind planted in the shared tmp dir) lends merge-file its config.
        await exec(
          "git",
          [
            "merge-file",
            "-L",
            "yours",
            "-L",
            "base",
            "-L",
            `upstream v${shared.version}`,
            currentTmp,
            baseTmp,
            newTmp,
          ],
          { cwd: tmpBase, env: { GIT_CEILING_DIRECTORIES: dirname(tmpBase) } },
        );
        // Clean merge — write result
        await writeCurrent(file, readFileSync(currentTmp, "utf-8"));
      } catch (e: unknown) {
        // git merge-file exits with the number of conflicts (capped at 127); an error is
        // negative, which arrives as 128-255.
        const exitCode =
          e && typeof e === "object" && "code" in e ? (e as { code: unknown }).code : null;
        if (typeof exitCode === "number" && exitCode >= 1 && exitCode <= 127) {
          // Conflict — write result with markers
          await writeCurrent(file, readFileSync(currentTmp, "utf-8"));
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
    // Don't commit — leave the markers for the mind to resolve. .upstream.json moves to the
    // new version first, so the next update starts from it and doesn't merge over them,
    // and the mind hears about them whatever the wiring below does.
    await writeUpstream(info);
    // The new version's deps and shims must not wait on the mind: from upstream's
    // SKILL.md, since the mind's may have markers in it.
    const wiringFailure = await wireSkill(mindName, dir, skillId, readSkillMd(sourceDir)).then(
      () => "",
      (e) =>
        ` Setting up v${shared.version}'s dependencies or commands also failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    const why =
      base === null
        ? `but Volute couldn't find the v${upstream.version} it started from (this skill arrived with you from another host), so it can't tell any edits of yours from upstream's changes. The markers show where your copy and v${shared.version} differ; they may be upstream's changes alone`
        : "but upstream changed the same parts you had edited, so it could not be merged on its own";
    await notifySkillConflict(
      mindName,
      skillId,
      `Your ${skillId} skill was updated to v${shared.version}, ${why}. Conflict markers (<<<<<<< yours / >>>>>>> upstream v${shared.version}) are in place in ${skillPaths(conflictFiles)} — choose what to keep, remove the markers, and commit.${wiringFailure}`,
    );
    return { status: "conflict", conflictFiles };
  }

  const npmDependencies = await wireSkill(mindName, dir, skillId, await readMindSkillMd());

  // .upstream.json only moves to the new version once the merge is committed:
  // written first, a failed commit would leave the skill reading as up to date.
  await git(["add", relSkillPath]);
  await git(["add", join("home", ".local", "hooks")]).catch(() => {});
  await git(["add", join("home", ".local", "bin")]).catch(() => {});
  if (npmDependencies.length > 0) {
    await git(["add", "package.json", "package-lock.json"]);
  }
  await ensureCommitIdentity(dir, mindName);
  // --allow-empty: a version bump need not change any file this mind tracks.
  await git(["commit", "--allow-empty", "-m", `Update skill: ${skillId} (v${shared.version})`]);
  await writeUpstream(info);
  await git(["add", join(relSkillPath, ".upstream.json")]);
  await git(["commit", "--amend", "--no-edit"]);

  return { status: "updated" };
}

/**
 * Wire a skill up the way installSkill does — otherwise a mind that installed it before
 * hooks (#228) or bins (#231) existed keeps the files but none of the npm deps or shims
 * they rely on. Returns the npm dependencies it installed.
 */
async function wireSkill(
  mindName: string,
  dir: string,
  skillId: string,
  declared: ReturnType<typeof parseSkillMd> | null,
): Promise<string[]> {
  const npmDependencies = declared?.npmDependencies ?? [];
  if (npmDependencies.length > 0) {
    try {
      await npmInstallAsMind(dir, mindName, npmDependencies);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Failed to install npm dependencies (${npmDependencies.join(", ")}): ${msg}`);
    }
  }
  reconcileSkillShims(mindName, dir, skillId, declared ?? { hooks: {}, bin: null });
  return npmDependencies;
}

async function notifySkillConflict(mindName: string, skillId: string, detail: string) {
  await recordNotice({
    mind: mindName,
    thread: MIND_LEVEL_THREAD,
    kind: "skill_conflict",
    reason: skillId,
    detail,
  }).catch((err) =>
    log.warn(`failed to notify ${mindName} of a skill conflict`, log.errorData(err)),
  );
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
    let name = entry.name;
    let description = "";

    try {
      const parsed = readSkillMd(skillDir);
      if (parsed?.name) name = parsed.name;
      description = parsed?.description ?? "";
    } catch (err) {
      // A SKILL.md that isn't a plain file is listed by its dir name alone.
      if (!isRefusal(err)) throw err;
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
  // Before anything is joined with it: the id names both the mind's dir and the staging one.
  validateSkillId(skillId);
  const skillDir = join(mindSkillsDir(dir), skillId);
  if (!existsSync(skillDir)) throw new Error(`Skill not found: ${skillId}`);

  const skillMdPath = join(skillDir, "SKILL.md");
  if (!existsSync(skillMdPath)) throw new Error(`SKILL.md not found in ${skillId}`);

  // Stage the skill out of the mind first, file by file through the mind-file helpers: the
  // daemon reads it as root, and anything but a plain dir or file — or one the mind swaps
  // for a link or FIFO mid-copy — refuses rather than handing a host file to the pool.
  const owner = await mindFileOwner(await getBaseName(mindName));
  const staging = mkdtempSync(join(tmpdir(), "volute-publish-"));
  try {
    const staged = join(staging, skillId);
    await stageMindTree(dir, relative(dir, skillDir), staged, owner, {
      left: MAX_PUBLISH_BYTES,
    });
    return await importSkillFromDir(staged, mindName, { untrusted: true });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Most a published skill may hold, all files together: the pool keeps it, and every mind
 * that installs it gets a copy.
 */
const MAX_PUBLISH_BYTES = 64 * 1024 * 1024;

/**
 * Copy a dir out of a mind into `dest` (made here), through the mind-file walk, refusing
 * once the files staged so far pass `budget.left` bytes.
 */
async function stageMindTree(
  dir: string,
  rel: string,
  dest: string,
  owner: MindFileOwner | null,
  budget: { left: number },
): Promise<void> {
  const real = await resolveMindDir(dir, rel, owner);
  if (!real) throw new Error(`not found: ${rel}`);
  mkdirSync(dest);
  for (const entry of readdirSync(real, { withFileTypes: true })) {
    const entryRel = join(rel, entry.name);
    if (entry.isDirectory()) {
      await stageMindTree(dir, entryRel, join(dest, entry.name), owner, budget);
    } else if (entry.isFile()) {
      const bytes = await readMindFileBytes(dir, entryRel, {
        owner,
        maxBytes: budget.left,
      }).catch((err) => {
        if (!(err instanceof MindFileTooLargeError)) throw err;
        throw new MindFileRefusedError(
          `refusing to publish ${rel}: larger than ${MAX_PUBLISH_BYTES} bytes in all`,
        );
      });
      budget.left -= bytes?.length ?? 0;
      // Keeps the permission bits (scripts may be executable), never setuid/setgid.
      const mode = lstatSync(join(real, entry.name)).mode & 0o777;
      if (bytes) writeFileSync(join(dest, entry.name), bytes, { flag: "wx", mode });
    } else {
      throw new MindFileRefusedError(
        `refusing ${join(dir, entryRel)}: not a directory or a regular file`,
      );
    }
  }
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
    const shimPath = join(dir, "home", ".local", "hooks", event, hookShimName(skillId));
    replaceShim(
      dir,
      `home/.local/hooks/${event}`,
      shimPath,
      shimContent(skillId, scriptPath, skillsSubdir),
    );
  }
}

export function removeHookShims(dir: string, skillId: string): void {
  // Only under plain dirs (a linked .local/hooks would aim the rm elsewhere); an event
  // dirent that is a link is not a directory here. A link at the shim's name is unlinked
  // itself, and anything but a file or link is left alone.
  if (!realDirChain(dir, "home/.local/hooks", false)) return;
  const hooksBase = join(dir, "home", ".local", "hooks");
  for (const eventDir of readdirSync(hooksBase, { withFileTypes: true })) {
    if (!eventDir.isDirectory()) continue;
    for (const prefix of [HOOK_SHIM_PREFIX, ...LEGACY_HOOK_SHIM_PREFIXES]) {
      removeShimEntry(join(hooksBase, eventDir.name, `${prefix}${skillId}.sh`));
    }
  }
}

/** Unlink a shim — a file, or a link itself — and nothing else. */
function removeShimEntry(abs: string): void {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(abs);
  } catch {
    return;
  }
  if (st.isFile() || st.isSymbolicLink()) rmSync(abs);
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

/** Read the owning skill id from an existing bin shim, or undefined if unmarked (or not a shim). */
function binShimOwner(shimPath: string): string | undefined {
  const line = (readShim(shimPath) ?? "").split("\n").find((l) => l.startsWith(BIN_SHIM_MARKER));
  return line?.slice(BIN_SHIM_MARKER.length).trim() || undefined;
}

export function installBinShim(
  dir: string,
  skillId: string,
  scriptPath: string,
  skillsSubdir: string = mindSkillsSubdir(dir),
): void {
  const shimPath = join(dir, "home", ".local", "bin", binCommandName(scriptPath));
  assertBinShimAvailable(dir, skillId, scriptPath);
  replaceShim(dir, "home/.local/bin", shimPath, binShimContent(skillId, scriptPath, skillsSubdir));
}

/**
 * Write a shim over whatever is at `abs`, under the same rules reconciliation keeps (see
 * below): its dirs must be plain directories, and the old entry is unlinked — a symlink
 * itself, never its target — before an exclusive create.
 */
function replaceShim(dir: string, relDir: string, abs: string, content: string): void {
  if (!realDirChain(dir, relDir, true)) {
    throw new Error(`not writing ${abs}: a parent is not a plain directory`);
  }
  rmSync(abs, { force: true });
  writeShim(abs, content);
}

/**
 * Refuse to overwrite a shim owned by a different skill — two skills that each
 * ship e.g. `scripts/sync.ts` must not silently clobber each other's command.
 */
function assertBinShimAvailable(dir: string, skillId: string, scriptPath: string): void {
  const cmdName = binCommandName(scriptPath);
  if (!realDirChain(dir, "home/.local/bin", false)) return;
  const shimPath = join(dir, "home", ".local", "bin", cmdName);
  if (!lexists(shimPath)) return;
  const owner = binShimOwner(shimPath);
  if (owner && owner !== skillId) {
    throw new Error(
      `Bin command "${cmdName}" is already provided by skill "${owner}"; skill "${skillId}" cannot overwrite it`,
    );
  }
}

export function removeBinShim(dir: string, scriptPath: string): void {
  // The name comes from the mind's own SKILL.md, so .local/bin must be a plain dir: a
  // link there (to /etc, with `bin: passwd`) would aim a root unlink outside the mind.
  if (!realDirChain(dir, "home/.local/bin", false)) return;
  removeShimEntry(join(dir, "home", ".local", "bin", binCommandName(scriptPath)));
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

/**
 * A shim's content, or null unless it is a small regular file with a single link. Through
 * one no-follow, non-blocking handle — a link or FIFO swapped in at the name refuses rather
 * than being read through or blocking the daemon, and a hard link to a file elsewhere is
 * never read.
 */
function readShim(abs: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > MAX_SHIM_BYTES) return null;
    // Bounded by the cap, not by fstat's size: the file can grow after it.
    const buf = Buffer.alloc(MAX_SHIM_BYTES + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return n > MAX_SHIM_BYTES ? null : buf.subarray(0, n).toString("utf-8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
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

/**
 * Make an exact generated shim executable again if it has lost the bit — an import
 * that dropped modes left them 0644 and off PATH (#1274). Through a no-follow handle,
 * so a link swapped in after {@link readShim} is refused rather than chmodded.
 * Returns whether it changed the mode.
 */
function restoreShimExecBit(abs: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink > 1 || (st.mode & 0o111) !== 0) return false;
    fchmodSync(fd, 0o755);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
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
      } else if (current === content && restoreShimExecBit(abs)) {
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
 *
 * Both skills dirs are the mind's, and the daemon may be root: they are resolved through
 * the mind-file walk, so one the mind linked out of its tree refuses rather than moving
 * skills in from, or out to, somewhere else.
 */
export async function migrateSkillsToTemplate(
  dir: string,
  oldTemplate: string,
  newTemplate: string,
  owner: MindFileOwner | null,
): Promise<string[]> {
  const oldSubdir = TEMPLATE_SKILLS_DIR[oldTemplate] ?? TEMPLATE_SKILLS_DIR.claude;
  const newSubdir = TEMPLATE_SKILLS_DIR[newTemplate] ?? TEMPLATE_SKILLS_DIR.claude;
  if (oldSubdir === newSubdir) return [];

  const oldDir = await resolveMindDir(dir, join("home", oldSubdir), owner);
  if (!oldDir) return [];

  // Dirent.isDirectory() doesn't follow links, so a linked entry is left behind.
  const skillIds = readdirSync(oldDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const migrated: string[] = [];
  if (skillIds.length > 0) {
    await ensureMindDir(dir, join("home", newSubdir), owner);
    for (const skillId of skillIds) {
      // The new template starts with no skills, so a collision is unexpected —
      // but be safe and let the migrated copy win. A link there is removed itself.
      await removeMindTree(dir, join("home", newSubdir, skillId), owner);
      // Both dirs re-contained right before the move: either may have been swapped for a
      // link since they were first resolved.
      const from = await resolveMindDir(dir, join("home", oldSubdir), owner);
      const to = await resolveMindDir(dir, join("home", newSubdir), owner);
      if (!from || !to) throw new Error(`skills dir vanished while migrating ${skillId}`);
      await rename(join(from, skillId), join(to, skillId));

      // Regenerate shims with the new skills subdir. The shim files live at the
      // same .local/hooks|bin paths regardless of template, so reinstalling
      // overwrites the stale ones in place.
      removeHookShims(dir, skillId);
      const skillMd = await readMindFile(dir, join("home", newSubdir, skillId, "SKILL.md"), {
        owner,
      });
      if (skillMd) {
        const { hooks, bin } = parseSkillMd(skillMd.text);
        installHookShims(dir, skillId, hooks, newSubdir);
        if (bin) installBinShim(dir, skillId, bin, newSubdir);
      }
      migrated.push(skillId);
    }
  }

  // Remove the now-empty old skills dir so marker-based detection stays clean — or, if
  // the mind made it a link into its own tree, just the link.
  await removeMindTree(dir, join("home", oldSubdir), owner);
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
