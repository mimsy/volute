import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import {
  getMindManager,
  initMindManager,
  tryGetMindManager,
} from "../packages/daemon/src/lib/daemon/mind-manager.js";
import {
  createExportArchive,
  extractArchive,
  trustedTemplateHash,
} from "../packages/daemon/src/lib/mind/archive.js";
import { readAppliedInfrastructureHash } from "../packages/daemon/src/lib/mind/infrastructure-sync.js";
import { importMindFromArchive } from "../packages/daemon/src/lib/mind/lifecycle.js";
import {
  addMind,
  findMind,
  mindDir,
  removeMind,
  stateDir,
} from "../packages/daemon/src/lib/mind/registry.js";
import {
  sharesTemplateBase,
  TEMPLATE_BRANCH,
} from "../packages/daemon/src/lib/mind/template-branch.js";
import { establishTemplateBase, runUpgrade } from "../packages/daemon/src/lib/mind/upgrade.js";
import {
  composeTemplate,
  copyTemplateToDir,
  findTemplatesRoot,
} from "../packages/daemon/src/lib/template/template.js";
import {
  computeInfrastructureHash,
  computeTemplateHash,
} from "../packages/daemon/src/lib/template/template-hash.js";

/**
 * A full-archive import carries no git history, so its fresh repo shared none
 * with volute/template: the first upgrade merged two unrelated histories and
 * conflicted on every template file that differed, and every upgrade after it
 * did the same (#1244). These drive real git over the real composed template.
 */

const STALE = "src/lib/logger.ts";
const MINE = "src/lib/mine.ts";

const names: string[] = [];
const scratch: string[] = [];

before(() => {
  if (!tryGetMindManager()) initMindManager();
});

after(async () => {
  for (const name of names) {
    if (await findMind(name)) await removeMind(name);
    rmSync(mindDir(name), { recursive: true, force: true });
    rmSync(stateDir(name), { recursive: true, force: true });
  }
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf-8" });
}

/** The template's own bytes for `rel`, as composed for `name`. */
function templateFile(rel: string, name: string): string {
  const { composedDir, manifest } = composeTemplate(findTemplatesRoot(), "claude");
  const out = mkdtempSync(resolve(tmpdir(), "tmpl-file-"));
  try {
    copyTemplateToDir(composedDir, out, name, manifest);
    return readFileSync(resolve(out, rel), "utf-8");
  } finally {
    rmSync(out, { recursive: true, force: true });
    rmSync(composedDir, { recursive: true, force: true });
  }
}

/**
 * A mind laid out from the claude template for `composedAs`, the way it would
 * arrive from a full archive: `.init/` applied away, one template file carrying
 * an older template's version, and one file the mind wrote itself.
 */
function archivedMind(name: string, composedAs = name): string {
  names.push(name);
  const dir = mindDir(name);
  const { composedDir, manifest } = composeTemplate(findTemplatesRoot(), "claude");
  try {
    copyTemplateToDir(composedDir, dir, composedAs, manifest);
  } finally {
    rmSync(composedDir, { recursive: true, force: true });
  }
  rmSync(resolve(dir, ".init"), { recursive: true, force: true });
  appendFileSync(resolve(dir, STALE), "// from an older template\n");
  writeFileSync(resolve(dir, MINE), "export const mine = true;\n");
  // Nothing in these merges touches dependencies, so the upgrade skips npm.
  mkdirSync(resolve(dir, "node_modules"), { recursive: true });
  return dir;
}

function commitAsImport(dir: string) {
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.name", "test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "import from archive");
}

function hasMergeBase(dir: string): boolean {
  try {
    git(dir, "merge-base", "HEAD", TEMPLATE_BRANCH);
    return true;
  } catch {
    return false;
  }
}

describe("an upgrade repairs a mind whose history never joined volute/template", () => {
  it("merges the current template in cleanly, keeping what the mind wrote", async () => {
    const name = `tb-repair-${process.pid}`;
    const dir = archivedMind(name);
    commitAsImport(dir);
    await addMind(name, 4191, undefined, "claude");

    const outcome = await runUpgrade(name, { restart: false });

    assert.equal(outcome.status, "upgraded", JSON.stringify(outcome));
    assert.equal(readFileSync(resolve(dir, STALE), "utf-8"), templateFile(STALE, name));
    assert.equal(readFileSync(resolve(dir, MINE), "utf-8"), "export const mine = true;\n");
    assert.ok(git(dir, "ls-files", MINE).trim(), "the mind's own file stays tracked");
    assert.ok(hasMergeBase(dir), "later upgrades merge 3-way");
    // The upgrade's own backfill counts, so the next daemon start doesn't redo it (#1266).
    assert.equal(readAppliedInfrastructureHash(name), computeInfrastructureHash("claude"));
  });

  it("replaces the orphan volute/template a failed upgrade left behind", async () => {
    const name = `tb-orphan-${process.pid}`;
    const dir = archivedMind(name);
    commitAsImport(dir);
    // What the pre-fix upgrade left: the current template, on a root commit.
    const wt = resolve(dir, ".variants", "orphan");
    git(dir, "worktree", "add", "--detach", wt);
    git(wt, "checkout", "--orphan", TEMPLATE_BRANCH);
    git(wt, "rm", "-rf", "--cached", ".");
    writeFileSync(resolve(wt, STALE), templateFile(STALE, name));
    git(wt, "add", STALE);
    git(wt, "commit", "-m", "template update");
    git(dir, "worktree", "remove", "--force", wt);
    assert.ok(!hasMergeBase(dir));
    await addMind(name, 4192, undefined, "claude");

    const outcome = await runUpgrade(name, { restart: false });

    assert.equal(outcome.status, "upgraded", JSON.stringify(outcome));
    assert.equal(readFileSync(resolve(dir, STALE), "utf-8"), templateFile(STALE, name));
    assert.ok(existsSync(resolve(dir, MINE)));
  });
});

describe("an upgrade holds crash recovery through its merge (#1279)", () => {
  it("takes the hold before the merge touches the tree and releases it after", async () => {
    const name = `tb-hold-${process.pid}`;
    const dir = archivedMind(name);
    commitAsImport(dir);
    await addMind(name, 4195, undefined, "claude");
    const stale = readFileSync(resolve(dir, STALE), "utf-8");

    const manager = getMindManager();
    const seen: { call: string; merged: boolean }[] = [];
    const merged = () => readFileSync(resolve(dir, STALE), "utf-8") !== stale;
    const hold = mock.method(manager, "holdRecovery", async () => {
      seen.push({ call: "hold", merged: merged() });
    });
    const release = mock.method(manager, "releaseRecovery", () => {
      seen.push({ call: "release", merged: merged() });
    });
    try {
      const outcome = await runUpgrade(name, { restart: false });
      assert.equal(outcome.status, "upgraded", JSON.stringify(outcome));
    } finally {
      hold.mock.restore();
      release.mock.restore();
    }

    assert.deepEqual(seen, [
      { call: "hold", merged: false },
      { call: "release", merged: true },
    ]);
  });
});

describe("sharesTemplateBase", () => {
  it("answers no only when git says no, and throws on anything else", async () => {
    const name = `tb-shares-${process.pid}`;
    const dir = archivedMind(name);
    commitAsImport(dir);
    assert.equal(await sharesTemplateBase(dir), false, "no volute/template");
    git(dir, "branch", TEMPLATE_BRANCH, git(dir, "commit-tree", "HEAD^{tree}", "-m", "x").trim());
    assert.equal(await sharesTemplateBase(dir), false, "an orphan volute/template");
    await establishTemplateBase(dir, "claude", "head", "test-mind");
    assert.equal(await sharesTemplateBase(dir), true);

    // A git failure is not an answer: reading it as "no base" would rebuild the
    // base from HEAD and hand the mind the template's copy of every file it edited.
    const notARepo = mkdtempSync(resolve(tmpdir(), "tb-not-a-repo-"));
    scratch.push(notARepo);
    await assert.rejects(sharesTemplateBase(notARepo));
  });
});

describe("establishTemplateBase", () => {
  it("leaves HEAD's tree alone and leaves the mind's own files out of the base", async () => {
    const name = `tb-head-${process.pid}`;
    const dir = archivedMind(name);
    commitAsImport(dir);
    const tree = git(dir, "rev-parse", "HEAD^{tree}").trim();

    await establishTemplateBase(dir, "claude", "head", "test-mind");

    assert.equal(git(dir, "rev-parse", "HEAD^{tree}").trim(), tree);
    assert.ok(hasMergeBase(dir));
    const base = git(dir, "ls-tree", "-r", "--name-only", TEMPLATE_BRANCH).split("\n");
    assert.ok(base.includes(STALE));
    assert.ok(!base.includes(MINE), "a file only the mind has would be deleted by the merge");
    assert.equal(git(dir, "status", "--porcelain").trim(), "");
  });

  it("with the composed template, keeps a mind's edit and still takes a template change", async () => {
    const name = `tb-composed-${process.pid}`;
    // The mind was created as `old-name`; it arrives here renamed.
    const dir = archivedMind(name, "old-name");
    // Built on exactly the current template, then edited by the mind.
    writeFileSync(
      resolve(dir, STALE),
      `${templateFile(STALE, "old-name")}// the mind's own edit\n`,
    );
    commitAsImport(dir);

    await establishTemplateBase(dir, "claude", { composedFor: "old-name" }, "test-mind");

    // The next template: renamed for this host, plus a change at the top of STALE.
    const wt = resolve(dir, ".variants", "next");
    git(dir, "worktree", "add", wt, TEMPLATE_BRANCH);
    writeFileSync(resolve(wt, "package.json"), templateFile("package.json", name));
    writeFileSync(
      resolve(wt, STALE),
      `// a template change\n${readFileSync(resolve(wt, STALE), "utf-8")}`,
    );
    git(wt, "commit", "-am", "template update");
    git(dir, "worktree", "remove", "--force", wt);

    git(dir, "merge", TEMPLATE_BRANCH, "-m", "merge template update");

    const stale = readFileSync(resolve(dir, STALE), "utf-8");
    assert.match(stale, /^\/\/ a template change\n/);
    assert.match(stale, /\/\/ the mind's own edit\n$/);
    assert.equal(JSON.parse(readFileSync(resolve(dir, "package.json"), "utf-8")).name, name);
  });

  it("with the composed template, a mind's edit survives an upgrade", async () => {
    const name = `tb-keeps-${process.pid}`;
    const dir = archivedMind(name);
    const edited = `${templateFile(STALE, name)}// the mind's own edit\n`;
    writeFileSync(resolve(dir, STALE), edited);
    commitAsImport(dir);
    await establishTemplateBase(dir, "claude", { composedFor: name }, "test-mind");
    await addMind(name, 4193, undefined, "claude");

    const outcome = await runUpgrade(name, { restart: false });

    assert.equal(outcome.status, "upgraded", JSON.stringify(outcome));
    assert.equal(readFileSync(resolve(dir, STALE), "utf-8"), edited);
  });
});

describe("a full-archive import", () => {
  function archive(from: string, templateHash?: string): { tempDir: string; manifest: any } {
    names.push(from);
    const dir = mindDir(from);
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    writeFileSync(resolve(dir, "home/SOUL.md"), "# Soul\n");
    writeFileSync(resolve(dir, "package.json"), `{"name":"${from}","private":true}\n`);
    mkdirSync(resolve(dir, "src"), { recursive: true });
    writeFileSync(resolve(dir, "src/agent.ts"), "// the mind's agent\n");
    const out = mkdtempSync(resolve(tmpdir(), "tb-archive-"));
    scratch.push(out);
    const path = resolve(out, "m.volute");
    createExportArchive({
      name: from,
      template: "claude",
      includeSrc: true,
      templateHash,
    }).writeZip(path);
    const tempDir = mkdtempSync(resolve(tmpdir(), "tb-extract-"));
    scratch.push(tempDir);
    return { tempDir, manifest: extractArchive(path, tempDir).manifest };
  }

  it("bases an archive that records no template on the mind's own files", async () => {
    const { tempDir, manifest } = archive(`tb-src-a-${process.pid}`);
    const to = `tb-dst-a-${process.pid}`;
    names.push(to);

    const result = await importMindFromArchive(tempDir, to, manifest);
    assert.ok(result.ok, JSON.stringify(result));

    const dir = mindDir(to);
    assert.ok(hasMergeBase(dir));
    assert.equal(
      git(dir, "show", `${TEMPLATE_BRANCH}:src/agent.ts`),
      "// the mind's agent\n",
      "never a base newer than the mind's own files",
    );
    assert.equal((await findMind(to))?.templateHash, undefined);
  });

  it("bases an archive on the current template when it records exactly that template", async () => {
    const from = `tb-src-b-${process.pid}`;
    const { tempDir, manifest } = archive(from, computeTemplateHash("claude"));
    assert.equal(manifest.templateHash, computeTemplateHash("claude"));
    const to = `tb-dst-b-${process.pid}`;
    names.push(to);

    const result = await importMindFromArchive(tempDir, to, manifest);
    assert.ok(result.ok, JSON.stringify(result));

    const dir = mindDir(to);
    assert.ok(hasMergeBase(dir));
    assert.equal(
      git(dir, "show", `${TEMPLATE_BRANCH}:src/agent.ts`),
      templateFile("src/agent.ts", from),
    );
    // Composed for the name the files were written for, not the new one.
    assert.equal(
      JSON.parse(git(dir, "show", `${TEMPLATE_BRANCH}:package.json`)).name,
      JSON.parse(templateFile("package.json", from)).name,
    );
  });
});

describe("an export records the template hash only where it is true", () => {
  it("leaves it out for a mind whose history never joined volute/template", async () => {
    const name = `tb-export-${process.pid}`;
    const dir = archivedMind(name);
    commitAsImport(dir);
    const hash = computeTemplateHash("claude");

    // A pre-#1244 full import: registry stamped, history orphaned.
    assert.equal(await trustedTemplateHash(dir, hash), undefined);

    await establishTemplateBase(dir, "claude", "head", "test-mind");
    assert.equal(await trustedTemplateHash(dir, hash), hash);
  });
});
