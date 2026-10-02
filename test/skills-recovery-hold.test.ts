import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { initMindManager } from "../packages/daemon/src/lib/daemon/mind-manager.js";
import { voluteHome } from "../packages/daemon/src/lib/mind/registry.js";
import {
  importSkillFromDir,
  installSkill,
  updateSkill,
} from "../packages/daemon/src/lib/skills.js";
import { createMindGitRepo } from "./helpers/git.js";
import { cleanGitEnv } from "./helpers/test-git-env.js";

/**
 * #1302: a skill's npm install rewrites the mind's tree, so a crash-recovery restart
 * landing mid-install would boot it on half-installed dependencies. The hold covers the
 * npm install and any cleanup that restores the tree after it, and not the git work.
 * Real npm, offline: each dependency is a local `file:` package. Its own file: the test
 * needs the MindManager singleton, which nothing can tear down again.
 */
describe("skill npm installs hold crash recovery", () => {
  const mindName = `skill-hold-mind-${process.pid}`;
  const mindDir = join(voluteHome(), "minds", mindName);
  const sourceRoot = join(voluteHome(), "tmp-skill-hold-source");
  const manager = initMindManager();

  before(async () => {
    const base = join(voluteHome(), "minds", `${mindName}-base`);
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "package.json"), '{"name":"m","version":"1.0.0"}\n');
    await createMindGitRepo(base);
    cpSync(base, mindDir, { recursive: true });
    rmSync(base, { recursive: true, force: true });
  });

  after(() => {
    for (const dir of [mindDir, sourceRoot]) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A local npm package npm installs offline. */
  function localPackage(name: string): string {
    const dir = join(sourceRoot, "packages", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), `{"name":"${name}","version":"1.0.0"}\n`);
    return `file:${dir}`;
  }

  function skillSource(
    name: string,
    opts: { deps?: string; description?: string; bin?: boolean } = {},
  ): string {
    const dir = join(sourceRoot, name);
    mkdirSync(join(dir, "scripts"), { recursive: true });
    const deps = opts.deps ? `npm-dependencies: ${opts.deps}\n` : "";
    const bin = opts.bin ? "metadata:\n  bin: scripts/sync.ts\n" : "";
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${opts.description ?? "d"}\n${deps}${bin}---\n`,
    );
    writeFileSync(join(dir, "scripts", "sync.ts"), "console.log('sync');\n");
    return dir;
  }

  /** What the mind's copy of `name` says, or "gone". */
  const skillState = (name: string) => {
    const path = join(mindDir, "home", ".claude", "skills", name, "SKILL.md");
    if (!existsSync(path)) return "gone";
    return readFileSync(path, "utf-8").match(/description: (\S+)/)?.[1] ?? "?";
  };
  const hasDep = (pkg: string) =>
    readFileSync(join(mindDir, "package.json"), "utf-8").includes(`"${pkg}"`);
  const lastCommit = () =>
    execFileSync("git", ["log", "-1", "--format=%s"], {
      cwd: mindDir,
      env: cleanGitEnv(),
      encoding: "utf-8",
    }).trim();

  /**
   * Record each hold and release with what the tree held at that moment: whether
   * package.json names `pkg`, what the skill `watched` reads as, and the last commit.
   */
  function recordHolds(pkg: string, watched: string): string[] {
    const events: string[] = [];
    const seen = () =>
      `${pkg}:${hasDep(pkg) ? "in" : "out"} ${watched}:${skillState(watched)} @ ${lastCommit()}`;
    manager.holdRecovery = async (name) => {
      assert.equal(name, mindName);
      events.push(`hold ${seen()}`);
    };
    manager.releaseRecovery = (name) => {
      assert.equal(name, mindName);
      events.push(`release ${seen()}`);
    };
    return events;
  }

  it("takes no hold for a skill without npm dependencies", async () => {
    const events = recordHolds("none", "plain");
    await importSkillFromDir(skillSource("plain"), "author");
    await installSkill(mindName, mindDir, "plain");
    assert.deepEqual(events, []);
  });

  it("holds across an install's npm run, and releases before the commit", async () => {
    const dep = localPackage("dep-a");
    const events = recordHolds("dep-a", "with-deps");
    await importSkillFromDir(skillSource("with-deps", { deps: dep }), "author");
    const before = lastCommit();
    await installSkill(mindName, mindDir, "with-deps");
    assert.deepEqual(events, [
      `hold dep-a:out with-deps:d @ ${before}`,
      `release dep-a:in with-deps:d @ ${before}`,
    ]);
    assert.equal(lastCommit(), "Install shared skill: with-deps");
  });

  it("holds across a failed install's cleanup", async () => {
    const events = recordHolds("dep-b", "bad-deps");
    await importSkillFromDir(skillSource("bad-deps", { deps: "file:./no-such-package" }), "author");
    const before = lastCommit();
    await assert.rejects(
      () => installSkill(mindName, mindDir, "bad-deps"),
      /Failed to install npm dependencies/,
    );
    assert.deepEqual(events, [
      `hold dep-b:out bad-deps:d @ ${before}`,
      `release dep-b:out bad-deps:gone @ ${before}`,
    ]);
  });

  it("puts the package files back, inside the hold, when the install fails after npm", async () => {
    // A bin command another skill already provides: npm succeeds, the shims refuse.
    await importSkillFromDir(skillSource("bin-owner", { bin: true }), "author");
    await installSkill(mindName, mindDir, "bin-owner");
    const dep = localPackage("dep-c");
    const events = recordHolds("dep-c", "bin-clash");
    await importSkillFromDir(skillSource("bin-clash", { deps: dep, bin: true }), "author");
    const before = lastCommit();
    await assert.rejects(
      () => installSkill(mindName, mindDir, "bin-clash"),
      /already provided by skill "bin-owner"/,
    );
    assert.deepEqual(events, [
      `hold dep-c:out bin-clash:d @ ${before}`,
      `release dep-c:out bin-clash:gone @ ${before}`,
    ]);
  });

  it("holds across an update's npm run, and releases before the commit", async () => {
    await importSkillFromDir(skillSource("upd", { description: "v1" }), "author");
    await installSkill(mindName, mindDir, "upd");
    const dep = localPackage("dep-d");
    const events = recordHolds("dep-d", "upd");
    await importSkillFromDir(skillSource("upd", { deps: dep, description: "v2" }), "author");
    const before = lastCommit();
    assert.equal((await updateSkill(mindName, mindDir, "upd")).status, "updated");
    assert.deepEqual(events, [
      `hold dep-d:out upd:v2 @ ${before}`,
      `release dep-d:in upd:v2 @ ${before}`,
    ]);
    assert.match(lastCommit(), /^Update skill: upd/);
  });

  it("holds across a failed update's undo", async () => {
    await importSkillFromDir(skillSource("upd-bad", { description: "v1" }), "author");
    await installSkill(mindName, mindDir, "upd-bad");
    const events = recordHolds("dep-e", "upd-bad");
    await importSkillFromDir(
      skillSource("upd-bad", { deps: "file:./no-such-package", description: "v2" }),
      "author",
    );
    const before = lastCommit();
    await assert.rejects(
      () => updateSkill(mindName, mindDir, "upd-bad"),
      /Failed to install npm dependencies/,
    );
    assert.deepEqual(events, [
      `hold dep-e:out upd-bad:v2 @ ${before}`,
      `release dep-e:out upd-bad:v1 @ ${before}`,
    ]);
  });
});
