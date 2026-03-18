import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { getDb } from "../src/lib/db.js";
import { exec } from "../src/lib/exec.js";
import { voluteHome } from "../src/lib/registry.js";
import { sharedSkills } from "../src/lib/schema.js";
import {
  getSharedSkill,
  importSkillFromDir,
  installHookShims,
  installSkill,
  listMindSkills,
  listSharedSkills,
  mindSkillsDir,
  parseSkillMd,
  publishSkill,
  removeHookShims,
  removeSharedSkill,
  sharedSkillsDir,
  syncBuiltinSkills,
  uninstallSkill,
  updateSkill,
} from "../src/lib/skills.js";
import { createMindGitRepo } from "./helpers/git.js";

async function cleanup() {
  const db = await getDb();
  await db.delete(sharedSkills);
  // Clean up filesystem
  const skillsDir = join(voluteHome(), "skills");
  if (existsSync(skillsDir)) rmSync(skillsDir, { recursive: true });
  const tmpDir = join(voluteHome(), "tmp-skill-source");
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
}

/** Create a temp skill source directory with SKILL.md */
function createSkillSource(name: string, description = "Test skill"): string {
  const dir = join(voluteHome(), "tmp-skill-source", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nContent here.\n`,
  );
  return dir;
}

describe("parseSkillMd", () => {
  it("parses name and description from frontmatter", () => {
    const result = parseSkillMd(
      "---\nname: My Skill\ndescription: A great skill\n---\n\n# Content",
    );
    assert.equal(result.name, "My Skill");
    assert.equal(result.description, "A great skill");
  });

  it("returns empty strings for missing frontmatter", () => {
    const result = parseSkillMd("# No frontmatter");
    assert.equal(result.name, "");
    assert.equal(result.description, "");
  });

  it("handles partial frontmatter", () => {
    const result = parseSkillMd("---\nname: Only Name\n---\n");
    assert.equal(result.name, "Only Name");
    assert.equal(result.description, "");
  });

  it("parses npm-dependencies from metadata", () => {
    const result = parseSkillMd(
      "---\nname: test\ndescription: test\nmetadata:\n  npm-dependencies: libsql\n---\n",
    );
    assert.deepEqual(result.npmDependencies, ["libsql"]);
  });

  it("parses multiple npm-dependencies", () => {
    const result = parseSkillMd(
      "---\nname: test\ndescription: test\nmetadata:\n  npm-dependencies: libsql better-sqlite3\n---\n",
    );
    assert.deepEqual(result.npmDependencies, ["libsql", "better-sqlite3"]);
  });

  it("returns empty array when no npm-dependencies", () => {
    const result = parseSkillMd("---\nname: test\ndescription: test\n---\n");
    assert.deepEqual(result.npmDependencies, []);
  });

  it("parses hooks from metadata", () => {
    const result = parseSkillMd(
      "---\nname: test\ndescription: test\nmetadata:\n  hooks:\n    pre-prompt: scripts/hook.sh\n---\n",
    );
    assert.deepEqual(result.hooks, { "pre-prompt": "scripts/hook.sh" });
  });

  it("parses multiple hooks", () => {
    const result = parseSkillMd(
      "---\nname: test\ndescription: test\nmetadata:\n  hooks:\n    pre-prompt: scripts/a.sh\n    post-tool-use: scripts/b.ts\n---\n",
    );
    assert.deepEqual(result.hooks, {
      "pre-prompt": "scripts/a.sh",
      "post-tool-use": "scripts/b.ts",
    });
  });

  it("returns empty hooks when none declared", () => {
    const result = parseSkillMd("---\nname: test\ndescription: test\n---\n");
    assert.deepEqual(result.hooks, {});
  });

  it("does not capture sibling metadata fields as hooks", () => {
    const result = parseSkillMd(
      "---\nname: test\ndescription: test\nmetadata:\n  hooks:\n    pre-prompt: scripts/hook.sh\n  npm-dependencies: libsql\n---\n",
    );
    assert.deepEqual(result.hooks, { "pre-prompt": "scripts/hook.sh" });
    assert.deepEqual(result.npmDependencies, ["libsql"]);
  });

  it("parses hooks from real resonance SKILL.md format", () => {
    const result = parseSkillMd(
      "---\nname: Resonance\ndescription: Semantic memory engine\nmetadata:\n  npm-dependencies: libsql\n  hooks:\n    pre-prompt: scripts/resonance-hook.sh\n---\n",
    );
    assert.deepEqual(result.hooks, { "pre-prompt": "scripts/resonance-hook.sh" });
    assert.deepEqual(result.npmDependencies, ["libsql"]);
  });
});

describe("shared skill CRUD", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("imports a skill from directory", async () => {
    const source = createSkillSource("test-skill", "A test skill");
    const skill = await importSkillFromDir(source, "test-mind");

    assert.equal(skill.id, "test-skill");
    assert.equal(skill.name, "test-skill");
    assert.equal(skill.description, "A test skill");
    assert.equal(skill.author, "test-mind");
    assert.equal(skill.version, 1);

    // Verify files were copied
    const destSkillMd = join(sharedSkillsDir(), "test-skill", "SKILL.md");
    assert.ok(existsSync(destSkillMd));
  });

  it("bumps version on re-import", async () => {
    const source = createSkillSource("test-skill");
    const first = await importSkillFromDir(source, "mind-a");
    assert.equal(first.version, 1);

    const second = await importSkillFromDir(source, "mind-b");
    assert.equal(second.version, 2);
    assert.equal(second.author, "mind-b");
  });

  it("lists shared skills", async () => {
    const source1 = createSkillSource("skill-a");
    const source2 = createSkillSource("skill-b");
    await importSkillFromDir(source1, "author");
    await importSkillFromDir(source2, "author");

    const skills = await listSharedSkills();
    assert.equal(skills.length, 2);
    const ids = skills.map((s) => s.id).sort();
    assert.deepEqual(ids, ["skill-a", "skill-b"]);
  });

  it("gets a shared skill by id", async () => {
    const source = createSkillSource("test-skill");
    await importSkillFromDir(source, "author");

    const skill = await getSharedSkill("test-skill");
    assert.ok(skill);
    assert.equal(skill.id, "test-skill");
  });

  it("returns undefined for missing skill", async () => {
    const skill = await getSharedSkill("nonexistent");
    assert.equal(skill, undefined);
  });

  it("removes a shared skill", async () => {
    const source = createSkillSource("test-skill");
    await importSkillFromDir(source, "author");

    await removeSharedSkill("test-skill");

    const skill = await getSharedSkill("test-skill");
    assert.equal(skill, undefined);
    assert.ok(!existsSync(join(sharedSkillsDir(), "test-skill")));
  });

  it("throws when removing nonexistent skill", async () => {
    await assert.rejects(() => removeSharedSkill("nonexistent"), /not found/i);
  });

  it("throws when importing without SKILL.md", async () => {
    const dir = join(voluteHome(), "tmp-skill-source", "empty");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), "no skill here");

    await assert.rejects(() => importSkillFromDir(dir, "author"), /SKILL\.md not found/);
  });
});

describe("mind skill operations", () => {
  let mindDir: string;
  const mindName = `skill-test-mind-${Date.now()}`;
  let baseRepoDir: string;

  async function mindCleanup() {
    await cleanup();
    const dir = join(voluteHome(), "minds", mindName);
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  }

  before(async () => {
    baseRepoDir = join(voluteHome(), "minds", `${mindName}-base`);
    await createMindGitRepo(baseRepoDir);
  });

  after(() => {
    if (existsSync(baseRepoDir)) rmSync(baseRepoDir, { recursive: true });
  });

  beforeEach(async () => {
    await mindCleanup();
    mindDir = join(voluteHome(), "minds", mindName);
    cpSync(baseRepoDir, mindDir, { recursive: true });
  });

  afterEach(mindCleanup);

  it("installs a shared skill into a mind", async () => {
    const source = createSkillSource("shared-skill");
    await importSkillFromDir(source, "author");

    await installSkill(mindName, mindDir, "shared-skill");

    // Verify files exist
    const skillMd = join(mindDir, "home", ".claude", "skills", "shared-skill", "SKILL.md");
    assert.ok(existsSync(skillMd));

    // Verify upstream tracking
    const upstreamPath = join(
      mindDir,
      "home",
      ".claude",
      "skills",
      "shared-skill",
      ".upstream.json",
    );
    assert.ok(existsSync(upstreamPath));
    const upstream = JSON.parse(readFileSync(upstreamPath, "utf-8"));
    assert.equal(upstream.source, "shared-skill");
    assert.equal(upstream.version, 1);
    assert.ok(upstream.baseCommit);

    // Verify git commit was made
    const log = await exec("git", ["log", "--oneline", "-1"], { cwd: mindDir });
    assert.ok(log.includes("Install shared skill: shared-skill"));
  });

  it("uninstalls a skill from a mind", async () => {
    const source = createSkillSource("shared-skill");
    await importSkillFromDir(source, "author");
    await installSkill(mindName, mindDir, "shared-skill");

    await uninstallSkill(mindName, mindDir, "shared-skill");

    const skillDir = join(mindDir, "home", ".claude", "skills", "shared-skill");
    assert.ok(!existsSync(skillDir));

    const log = await exec("git", ["log", "--oneline", "-1"], { cwd: mindDir });
    assert.ok(log.includes("Uninstall skill: shared-skill"));
  });

  it("publishes a mind skill to shared repository", async () => {
    // Create a custom skill in the mind
    const skillDir = join(mindDir, "home", ".claude", "skills", "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: My Custom Skill\ndescription: My own skill\n---\n\nContent\n",
    );

    const published = await publishSkill(mindName, mindDir, "my-skill");
    assert.equal(published.id, "my-skill");
    assert.equal(published.name, "My Custom Skill");
    assert.equal(published.author, mindName);

    // Verify in shared repo
    const shared = await getSharedSkill("my-skill");
    assert.ok(shared);
    assert.equal(shared.name, "My Custom Skill");
  });

  it("lists mind skills with update status", async () => {
    const source = createSkillSource("shared-skill");
    await importSkillFromDir(source, "author");
    await installSkill(mindName, mindDir, "shared-skill");

    const skills = await listMindSkills(mindDir);
    assert.equal(skills.length, 1);
    assert.equal(skills[0].id, "shared-skill");
    assert.equal(skills[0].updateAvailable, false);
    assert.ok(skills[0].upstream);

    // Bump shared version
    await importSkillFromDir(source, "author");

    const skills2 = await listMindSkills(mindDir);
    assert.equal(skills2[0].updateAvailable, true);
  });

  it("updates a skill — clean merge (no local changes)", async () => {
    const source = createSkillSource("shared-skill", "Version 1");
    await importSkillFromDir(source, "author");
    await installSkill(mindName, mindDir, "shared-skill");

    // Update the shared skill
    writeFileSync(
      join(source, "SKILL.md"),
      "---\nname: shared-skill\ndescription: Version 2\n---\n\n# Updated Content\n",
    );
    await importSkillFromDir(source, "author");

    const result = await updateSkill(mindName, mindDir, "shared-skill");
    assert.equal(result.status, "updated");

    // Verify content was updated
    const content = readFileSync(
      join(mindDir, "home", ".claude", "skills", "shared-skill", "SKILL.md"),
      "utf-8",
    );
    assert.ok(content.includes("Updated Content"));
  });

  it("returns up-to-date when no new version", async () => {
    const source = createSkillSource("shared-skill");
    await importSkillFromDir(source, "author");
    await installSkill(mindName, mindDir, "shared-skill");

    const result = await updateSkill(mindName, mindDir, "shared-skill");
    assert.equal(result.status, "up-to-date");
  });

  it("handles conflict during update", async () => {
    const source = createSkillSource("shared-skill", "Original");
    await importSkillFromDir(source, "author");
    await installSkill(mindName, mindDir, "shared-skill");

    // Modify locally
    const localPath = join(mindDir, "home", ".claude", "skills", "shared-skill", "SKILL.md");
    writeFileSync(
      localPath,
      "---\nname: shared-skill\ndescription: Original\n---\n\n# Local Change\n\nMy custom content.\n",
    );
    await exec("git", ["add", "-A"], { cwd: mindDir });
    await exec("git", ["commit", "-m", "local edit"], { cwd: mindDir });

    // Update shared version with conflicting change
    writeFileSync(
      join(source, "SKILL.md"),
      "---\nname: shared-skill\ndescription: Original\n---\n\n# Upstream Change\n\nDifferent content.\n",
    );
    await importSkillFromDir(source, "author");

    const result = await updateSkill(mindName, mindDir, "shared-skill");
    assert.equal(result.status, "conflict");
    assert.ok(result.conflictFiles);
    assert.ok(result.conflictFiles.includes("SKILL.md"));
  });

  it("throws when installing already-installed skill", async () => {
    const source = createSkillSource("shared-skill");
    await importSkillFromDir(source, "author");
    await installSkill(mindName, mindDir, "shared-skill");

    await assert.rejects(
      () => installSkill(mindName, mindDir, "shared-skill"),
      /already installed/i,
    );
  });

  it("throws when uninstalling non-installed skill", async () => {
    await assert.rejects(() => uninstallSkill(mindName, mindDir, "nonexistent"), /not installed/i);
  });

  it("rejects invalid skill IDs", async () => {
    await assert.rejects(() => installSkill(mindName, mindDir, "../escape"), /Invalid skill ID/);
    await assert.rejects(() => installSkill(mindName, mindDir, "foo/bar"), /Invalid skill ID/);
    await assert.rejects(() => installSkill(mindName, mindDir, ""), /Invalid skill ID/);
  });

  it("updates a skill — new file added upstream", async () => {
    const source = createSkillSource("shared-skill", "V1");
    await importSkillFromDir(source, "author");
    await installSkill(mindName, mindDir, "shared-skill");

    // Add a new file to the shared skill
    writeFileSync(join(source, "extra.md"), "# Extra file\n");
    await importSkillFromDir(source, "author");

    const result = await updateSkill(mindName, mindDir, "shared-skill");
    assert.equal(result.status, "updated");

    // Verify new file was copied
    const extraPath = join(mindDir, "home", ".claude", "skills", "shared-skill", "extra.md");
    assert.ok(existsSync(extraPath));
    assert.ok(readFileSync(extraPath, "utf-8").includes("Extra file"));
  });

  it("updates a skill — file deleted upstream (unmodified locally)", async () => {
    const source = createSkillSource("shared-skill", "V1");
    writeFileSync(join(source, "removeme.md"), "# Will be removed\n");
    await importSkillFromDir(source, "author");
    await installSkill(mindName, mindDir, "shared-skill");

    // Verify file was installed
    const removePath = join(mindDir, "home", ".claude", "skills", "shared-skill", "removeme.md");
    assert.ok(existsSync(removePath));

    // Remove file from shared and re-publish
    rmSync(join(source, "removeme.md"));
    await importSkillFromDir(source, "author");

    const result = await updateSkill(mindName, mindDir, "shared-skill");
    assert.equal(result.status, "updated");

    // File should be removed since it wasn't modified locally
    assert.ok(!existsSync(removePath));
  });

  it("updates a skill — preserves local changes when upstream unchanged", async () => {
    const source = createSkillSource("shared-skill", "V1");
    writeFileSync(join(source, "extra.md"), "# Original\n");
    await importSkillFromDir(source, "author");
    await installSkill(mindName, mindDir, "shared-skill");

    // Modify extra.md locally
    const localExtra = join(mindDir, "home", ".claude", "skills", "shared-skill", "extra.md");
    writeFileSync(localExtra, "# My local changes\n");
    await exec("git", ["add", "-A"], { cwd: mindDir });
    await exec("git", ["commit", "-m", "local edit"], { cwd: mindDir });

    // Re-publish shared with same extra.md but updated SKILL.md
    writeFileSync(
      join(source, "SKILL.md"),
      "---\nname: shared-skill\ndescription: V2\n---\n\n# V2 content\n",
    );
    await importSkillFromDir(source, "author");

    const result = await updateSkill(mindName, mindDir, "shared-skill");
    assert.equal(result.status, "updated");

    // Local changes to extra.md should be preserved
    assert.ok(readFileSync(localExtra, "utf-8").includes("My local changes"));
  });
});

describe("syncBuiltinSkills", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("syncs built-in skills with author 'volute'", async () => {
    await syncBuiltinSkills();

    const skills = await listSharedSkills();
    assert.ok(skills.length > 0, "should have synced at least one skill");

    // All built-in skills should have author "volute"
    for (const skill of skills) {
      assert.equal(skill.author, "volute");
    }

    // Check specific known skills exist
    const ids = skills.map((s) => s.id).sort();
    assert.ok(ids.includes("memory"), "should include memory skill");
    assert.ok(ids.includes("orientation"), "should include orientation skill");
    assert.ok(ids.includes("volute-mind"), "should include volute-mind skill");

    // Verify files were copied to shared dir
    assert.ok(existsSync(join(sharedSkillsDir(), "memory", "SKILL.md")));
    assert.ok(existsSync(join(sharedSkillsDir(), "orientation", "SKILL.md")));
  });

  it("does not bump version on repeated sync with same content", async () => {
    await syncBuiltinSkills();

    const first = await getSharedSkill("memory");
    assert.ok(first);
    const firstVersion = first.version;

    // Sync again — content unchanged, version should stay the same
    await syncBuiltinSkills();

    const second = await getSharedSkill("memory");
    assert.ok(second);
    assert.equal(second.version, firstVersion, "version should not bump when content is unchanged");
  });

  it("bumps version when content changes", async () => {
    await syncBuiltinSkills();

    const first = await getSharedSkill("memory");
    assert.ok(first);

    // Manually modify the shared copy to make hashes differ on next sync
    const sharedSkillMd = join(sharedSkillsDir(), "memory", "SKILL.md");
    writeFileSync(sharedSkillMd, "modified content");

    await syncBuiltinSkills();

    const second = await getSharedSkill("memory");
    assert.ok(second);
    assert.equal(second.version, first.version + 1, "version should bump when content differs");
  });
});

describe("hook shim management", () => {
  it("installs hook shims for declared hooks", () => {
    const dir = join(voluteHome(), "test-hooks-mind");
    mkdirSync(join(dir, "home", ".config", "hooks"), { recursive: true });

    installHookShims(dir, "resonance", {
      "pre-prompt": "scripts/resonance-hook.sh",
    });

    const shimPath = join(dir, "home", ".config", "hooks", "pre-prompt", "50-resonance.sh");
    assert.ok(existsSync(shimPath), "shim file should exist");
    const content = readFileSync(shimPath, "utf-8");
    assert.ok(content.includes("exec bash"), "shim should use bash for .sh scripts");
    assert.ok(
      content.includes(".claude/skills/resonance/scripts/resonance-hook.sh"),
      "shim should reference skill script",
    );

    rmSync(dir, { recursive: true });
  });

  it("installs .ts hook shims with npx tsx", () => {
    const dir = join(voluteHome(), "test-hooks-ts");
    mkdirSync(join(dir, "home", ".config", "hooks"), { recursive: true });

    installHookShims(dir, "test-skill", {
      "post-tool-use": "scripts/hook.ts",
    });

    const shimPath = join(dir, "home", ".config", "hooks", "post-tool-use", "50-test-skill.sh");
    assert.ok(existsSync(shimPath));
    const content = readFileSync(shimPath, "utf-8");
    assert.ok(content.includes("exec npx tsx"), "shim should use npx tsx for .ts scripts");

    rmSync(dir, { recursive: true });
  });

  it("removes hook shims for a skill", () => {
    const dir = join(voluteHome(), "test-hooks-remove");
    const eventDir = join(dir, "home", ".config", "hooks", "pre-prompt");
    mkdirSync(eventDir, { recursive: true });

    // Create a shim
    writeFileSync(join(eventDir, "50-resonance.sh"), "#!/bin/bash\necho test");
    // Create another skill's shim that should be kept
    writeFileSync(join(eventDir, "50-other-skill.sh"), "#!/bin/bash\necho other");

    removeHookShims(dir, "resonance");

    assert.ok(!existsSync(join(eventDir, "50-resonance.sh")), "resonance shim should be removed");
    assert.ok(existsSync(join(eventDir, "50-other-skill.sh")), "other skill shim should be kept");

    rmSync(dir, { recursive: true });
  });

  it("handles remove when hooks dir does not exist", () => {
    const dir = join(voluteHome(), "test-hooks-nodir");
    // Should not throw
    removeHookShims(dir, "resonance");
  });

  it("installs multiple hooks for different events", () => {
    const dir = join(voluteHome(), "test-hooks-multi");
    mkdirSync(join(dir, "home", ".config", "hooks"), { recursive: true });

    installHookShims(dir, "my-skill", {
      "pre-prompt": "scripts/pre.sh",
      "post-tool-use": "scripts/post.sh",
    });

    assert.ok(existsSync(join(dir, "home", ".config", "hooks", "pre-prompt", "50-my-skill.sh")));
    assert.ok(existsSync(join(dir, "home", ".config", "hooks", "post-tool-use", "50-my-skill.sh")));

    rmSync(dir, { recursive: true });
  });

  it("installs hook shims with correct path for codex template", () => {
    const dir = join(voluteHome(), "test-hooks-codex");
    mkdirSync(join(dir, "home", ".config", "hooks"), { recursive: true });
    // Create AGENTS.md marker file to indicate codex template
    writeFileSync(join(dir, "home", "AGENTS.md"), "");

    installHookShims(dir, "resonance", {
      "pre-prompt": "scripts/resonance-hook.sh",
    });

    const shimPath = join(dir, "home", ".config", "hooks", "pre-prompt", "50-resonance.sh");
    assert.ok(existsSync(shimPath), "shim file should exist");
    const content = readFileSync(shimPath, "utf-8");
    assert.ok(
      content.includes(".agents/skills/resonance/scripts/resonance-hook.sh"),
      "codex shim should reference .agents/skills path",
    );
    assert.ok(
      !content.includes(".claude/skills"),
      "codex shim should not reference .claude/skills path",
    );

    rmSync(dir, { recursive: true });
  });
});

describe("mindSkillsDir template detection", () => {
  it("resolves to .claude/skills by default", () => {
    const dir = join(voluteHome(), "test-skills-dir-claude");
    mkdirSync(join(dir, "home"), { recursive: true });

    const result = mindSkillsDir(dir);
    assert.ok(result.endsWith(join("home", ".claude", "skills")));

    rmSync(dir, { recursive: true });
  });

  it("resolves to .agents/skills when AGENTS.md exists", () => {
    const dir = join(voluteHome(), "test-skills-dir-codex");
    mkdirSync(join(dir, "home"), { recursive: true });
    writeFileSync(join(dir, "home", "AGENTS.md"), "");

    const result = mindSkillsDir(dir);
    assert.ok(result.endsWith(join("home", ".agents", "skills")));

    rmSync(dir, { recursive: true });
  });

  it("resolves to .pi/skills when MINDS.md exists", () => {
    const dir = join(voluteHome(), "test-skills-dir-pi");
    mkdirSync(join(dir, "home"), { recursive: true });
    writeFileSync(join(dir, "home", "MINDS.md"), "");

    const result = mindSkillsDir(dir);
    assert.ok(result.endsWith(join("home", ".pi", "skills")));

    rmSync(dir, { recursive: true });
  });

  it("prefers AGENTS.md over MINDS.md when both exist", () => {
    const dir = join(voluteHome(), "test-skills-dir-both");
    mkdirSync(join(dir, "home"), { recursive: true });
    writeFileSync(join(dir, "home", "AGENTS.md"), "");
    writeFileSync(join(dir, "home", "MINDS.md"), "");

    const result = mindSkillsDir(dir);
    assert.ok(result.endsWith(join("home", ".agents", "skills")));

    rmSync(dir, { recursive: true });
  });
});
