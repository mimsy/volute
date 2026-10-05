import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  initMindManager,
  tryGetMindManager,
} from "../packages/daemon/src/lib/daemon/mind-manager.js";
import {
  addMind,
  findMind,
  mindDir,
  removeMind,
  stateDir,
} from "../packages/daemon/src/lib/mind/registry.js";
import { runUpgrade } from "../packages/daemon/src/lib/mind/upgrade.js";
import {
  composeTemplate,
  copyTemplateToDir,
  findTemplatesRoot,
} from "../packages/daemon/src/lib/template/template.js";

/**
 * The home/ allowlist migration untracks all of home/ and re-adds it. It used
 * to run on every upgrade, so each one put two commits touching every home
 * file into the mind's own history (#1392). It should run only for a mind
 * whose tracked home/ doesn't already match the allowlist.
 */

const PREP = "prepare for home/ allowlist migration";
const READD = "re-add allowlisted home files";

const names: string[] = [];

before(() => {
  if (!tryGetMindManager()) initMindManager();
});

after(async () => {
  for (const name of names) {
    if (await findMind(name)) await removeMind(name);
    rmSync(mindDir(name), { recursive: true, force: true });
    rmSync(stateDir(name), { recursive: true, force: true });
  }
});

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf-8" });
}

/** A claude-template mind on disk with a SOUL.md, deps "installed". */
function layOutMind(name: string): string {
  names.push(name);
  const dir = mindDir(name);
  const { composedDir, manifest } = composeTemplate(findTemplatesRoot(), "claude");
  try {
    copyTemplateToDir(composedDir, dir, name, manifest);
  } finally {
    rmSync(composedDir, { recursive: true, force: true });
  }
  rmSync(resolve(dir, ".init"), { recursive: true, force: true });
  writeFileSync(resolve(dir, "home/SOUL.md"), `I am ${name}.\n`);
  // Nothing in these merges touches dependencies, so the upgrade skips npm.
  mkdirSync(resolve(dir, "node_modules"), { recursive: true });
  return dir;
}

function commitAll(dir: string) {
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.name", "test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "initial");
}

function subjectsSince(dir: string, rev: string): string[] {
  return git(dir, "log", "--format=%s", `${rev}..HEAD`).split("\n").filter(Boolean);
}

function trackedHome(dir: string): string[] {
  return git(dir, "ls-files", "--", "home/").split("\n").filter(Boolean).sort();
}

async function upgrade(name: string) {
  const outcome = await runUpgrade(name, { restart: false });
  assert.equal(outcome.status, "upgraded", JSON.stringify(outcome));
}

describe("the home/ allowlist migration runs only when it changes something (#1392)", () => {
  it("leaves an already-allowlisted mind's home/ history alone", async () => {
    const name = `al-current-${process.pid}`;
    const dir = layOutMind(name);
    commitAll(dir);
    await addMind(name, 4301, undefined, "claude");
    const before = git(dir, "rev-parse", "HEAD").trim();
    const home = trackedHome(dir);
    assert.ok(home.includes("home/SOUL.md"));

    await upgrade(name);
    const afterFirst = git(dir, "rev-parse", "HEAD").trim();
    await upgrade(name);

    const subjects = subjectsSince(dir, before);
    assert.ok(!subjects.includes(PREP), subjects.join("\n"));
    assert.ok(!subjects.includes(READD), subjects.join("\n"));
    // The second upgrade had nothing to bring: it adds no commits at all.
    assert.equal(git(dir, "rev-parse", "HEAD").trim(), afterFirst);
    assert.deepEqual(trackedHome(dir), home);
  });

  it("migrates a pre-allowlist mind, keeping its untracked files on disk", async () => {
    const name = `al-legacy-${process.pid}`;
    const dir = layOutMind(name);
    // Before the allowlist, home/ was tracked wholesale.
    writeFileSync(resolve(dir, ".gitignore"), "node_modules/\n.variants/\n.mind/\n");
    mkdirSync(resolve(dir, "home/.claude/projects"), { recursive: true });
    writeFileSync(resolve(dir, "home/notes.txt"), "scratch\n");
    writeFileSync(resolve(dir, "home/.claude/projects/s.jsonl"), "{}\n");
    commitAll(dir);
    assert.ok(trackedHome(dir).includes("home/notes.txt"));
    await addMind(name, 4302, undefined, "claude");
    const before = git(dir, "rev-parse", "HEAD").trim();

    await upgrade(name);

    const subjects = subjectsSince(dir, before);
    assert.ok(subjects.includes(PREP), subjects.join("\n"));
    const home = trackedHome(dir);
    assert.ok(home.includes("home/SOUL.md"), "an allowlisted file stays tracked");
    assert.ok(!home.includes("home/notes.txt"));
    assert.ok(!home.includes("home/.claude/projects/s.jsonl"));
    assert.ok(existsSync(resolve(dir, "home/notes.txt")), "untracked, not deleted");
    assert.ok(existsSync(resolve(dir, "home/.claude/projects/s.jsonl")));

    // Migrated now: the next upgrade leaves it alone.
    const migrated = git(dir, "rev-parse", "HEAD").trim();
    await upgrade(name);
    assert.equal(git(dir, "rev-parse", "HEAD").trim(), migrated);
  });

  it("untracks a home file the mind's own .gitignore ignores", async () => {
    const name = `al-stray-${process.pid}`;
    const dir = layOutMind(name);
    mkdirSync(resolve(dir, "home/memory"), { recursive: true });
    writeFileSync(resolve(dir, "home/memory/scratch.md"), "x\n");
    commitAll(dir);
    await addMind(name, 4303, undefined, "claude");
    // The first upgrade gives it a template merge base to diverge from.
    await upgrade(name);
    // The allowlist tracks memory/; this mind chose to stop tracking one file.
    writeFileSync(
      resolve(dir, ".gitignore"),
      `${git(dir, "show", "HEAD:.gitignore")}home/memory/scratch.md\n`,
    );
    git(dir, "commit", "-am", "stop tracking scratch");
    assert.ok(trackedHome(dir).includes("home/memory/scratch.md"));

    await upgrade(name);

    assert.ok(!trackedHome(dir).includes("home/memory/scratch.md"));
    assert.ok(existsSync(resolve(dir, "home/memory/scratch.md")));
  });

  it("protects home files the template stopped tracking since the merge base", async () => {
    const name = `al-dropped-${process.pid}`;
    const dir = layOutMind(name);
    commitAll(dir);
    // An old volute/template that still carried home/SOUL.md: the merge
    // would read the current template as deleting it.
    git(dir, "branch", "volute/template", "HEAD");
    await addMind(name, 4304, undefined, "claude");

    await upgrade(name);

    assert.ok(existsSync(resolve(dir, "home/SOUL.md")));
    assert.ok(trackedHome(dir).includes("home/SOUL.md"));
  });

  it("respects a mind's own un-ignore across upgrades", async () => {
    const name = `al-projects-${process.pid}`;
    const dir = layOutMind(name);
    commitAll(dir);
    await addMind(name, 4305, undefined, "claude");
    await upgrade(name);
    // The mind chose to version its projects too.
    mkdirSync(resolve(dir, "home/projects"), { recursive: true });
    writeFileSync(resolve(dir, "home/projects/poem.md"), "a poem\n");
    writeFileSync(
      resolve(dir, ".gitignore"),
      `${git(dir, "show", "HEAD:.gitignore")}!home/projects/\n!home/projects/**\n`,
    );
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "track my projects");
    assert.ok(trackedHome(dir).includes("home/projects/poem.md"));
    const before = git(dir, "rev-parse", "HEAD").trim();

    await upgrade(name);
    await upgrade(name);

    assert.equal(git(dir, "rev-parse", "HEAD").trim(), before);
    assert.ok(trackedHome(dir).includes("home/projects/poem.md"));
  });
});
