import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { getDb } from "./db.js";
import { exec, gitExec } from "./exec.js";
import log from "./logger.js";
import { voluteHome } from "./registry.js";
import { sharedSkills } from "./schema.js";

const VALID_SKILL_ID = /^[a-zA-Z0-9_-]+$/;

/** Skills installed for seed minds (pre-sprout) */
export const SEED_SKILLS = ["orientation", "memory"];

/** Skills installed for fully sprouted minds */
export const STANDARD_SKILLS = ["volute-mind", "memory", "sessions"];

function validateSkillId(id: string): void {
  if (!id || !VALID_SKILL_ID.test(id)) {
    throw new Error(`Invalid skill ID: ${id}`);
  }
}

// --- Shared skill operations ---

export function sharedSkillsDir(): string {
  return resolve(voluteHome(), "skills");
}

export function parseSkillMd(content: string): { name: string; description: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { name: "", description: "" };
  const frontmatter = match[1];

  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
  return {
    name: nameMatch?.[1].trim() ?? "",
    description: descMatch?.[1].trim() ?? "",
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

  const destDir = join(sharedSkillsDir(), id);
  // Clean destination before copying to remove files deleted from source
  if (existsSync(destDir)) rmSync(destDir, { recursive: true });
  mkdirSync(destDir, { recursive: true });

  cpSync(sourceDir, destDir, { recursive: true });

  // Remove .upstream.json if present (it's a mind-side tracking file)
  const upstreamPath = join(destDir, ".upstream.json");
  if (existsSync(upstreamPath)) rmSync(upstreamPath);

  const db = await getDb();
  const existing = await db.select().from(sharedSkills).where(eq(sharedSkills.id, id)).get();
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

export function mindSkillsDir(dir: string): string {
  return resolve(dir, "home", ".claude", "skills");
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
  } catch {
    return null;
  }
}

export async function installSkill(_mindName: string, dir: string, skillId: string): Promise<void> {
  validateSkillId(skillId);
  const shared = await getSharedSkill(skillId);
  if (!shared) throw new Error(`Shared skill not found: ${skillId}`);

  const sourceDir = join(sharedSkillsDir(), skillId);
  if (!existsSync(sourceDir)) throw new Error(`Shared skill files not found: ${skillId}`);

  const destDir = join(mindSkillsDir(dir), skillId);
  if (existsSync(destDir)) throw new Error(`Skill already installed: ${skillId}`);

  mkdirSync(destDir, { recursive: true });
  cpSync(sourceDir, destDir, { recursive: true });

  // Write upstream tracking file
  // We need to commit first, then get the hash, then write upstream and amend
  await gitExec(["add", join("home", ".claude", "skills", skillId)], { cwd: dir });
  await gitExec(["commit", "-m", `Install shared skill: ${skillId}`], { cwd: dir });
  const commitHash = (await gitExec(["rev-parse", "HEAD"], { cwd: dir })).trim();

  const upstream: UpstreamInfo = {
    source: skillId,
    version: shared.version,
    baseCommit: commitHash,
  };
  writeFileSync(join(destDir, ".upstream.json"), `${JSON.stringify(upstream, null, 2)}\n`);
  await gitExec(["add", join("home", ".claude", "skills", skillId, ".upstream.json")], {
    cwd: dir,
  });
  await gitExec(["commit", "--amend", "--no-edit"], { cwd: dir });
}

export async function uninstallSkill(
  _mindName: string,
  dir: string,
  skillId: string,
): Promise<void> {
  validateSkillId(skillId);
  const skillDir = join(mindSkillsDir(dir), skillId);
  if (!existsSync(skillDir)) throw new Error(`Skill not installed: ${skillId}`);

  rmSync(skillDir, { recursive: true });
  await gitExec(["add", join("home", ".claude", "skills", skillId)], { cwd: dir });
  await gitExec(["commit", "-m", `Uninstall skill: ${skillId}`], { cwd: dir });
}

export type UpdateResult =
  | { status: "updated" }
  | { status: "up-to-date" }
  | { status: "conflict"; conflictFiles: string[] };

export async function updateSkill(
  _mindName: string,
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

  // Collect all files from current, base (git), and new (shared)
  const relSkillPath = join("home", ".claude", "skills", skillId);
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
            { cwd: dir },
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
          { cwd: dir },
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

  // Update upstream tracking
  const upstreamInfo: UpstreamInfo = {
    source: upstream.source,
    version: shared.version,
    baseCommit: upstream.baseCommit, // will update after commit
  };
  writeFileSync(join(skillDir, ".upstream.json"), `${JSON.stringify(upstreamInfo, null, 2)}\n`);

  await gitExec(["add", relSkillPath], { cwd: dir });
  await gitExec(["commit", "-m", `Update skill: ${skillId} (v${shared.version})`], { cwd: dir });
  const commitHash = (await gitExec(["rev-parse", "HEAD"], { cwd: dir })).trim();

  // Update baseCommit to the new commit
  upstreamInfo.baseCommit = commitHash;
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
export function findSkillsRoot(): string {
  let dir = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(dir, "skills");
    if (existsSync(candidate) && readdirSync(candidate).length > 0) return candidate;
    dir = dirname(dir);
  }
  throw new Error("Skills directory not found");
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

      // Check if shared pool already has this version
      const destDir = join(sharedSkillsDir(), entry.name);
      if (existsSync(destDir)) {
        const destHash = hashSkillDir(destDir);
        if (sourceHash === destHash) continue;
      }

      await importSkillFromDir(sourceDir, "volute");
      log.info(`synced built-in skill: ${entry.name}`);
    } catch (err) {
      log.error(`failed to sync built-in skill: ${entry.name}`, log.errorData(err));
    }
  }
}
