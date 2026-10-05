import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  initMindManager,
  tryGetMindManager,
} from "../packages/daemon/src/lib/daemon/mind-manager.js";
import { createExportArchive, extractArchive } from "../packages/daemon/src/lib/mind/archive.js";
import { createVariant, importMindFromArchive } from "../packages/daemon/src/lib/mind/lifecycle.js";
import {
  addMind,
  findMind,
  mindDir,
  removeMind,
  stateDir,
} from "../packages/daemon/src/lib/mind/registry.js";

/**
 * The npm install on import and split can write a lockfile the repo never had. Like
 * after an upgrade or join (#1385), it is committed rather than left dirty in the
 * mind's own `git status` (#1389). Both run a real, offline npm install over a
 * dependency-free package.json.
 */

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

function initRepo(dir: string) {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
}

/** A repo whose config names no one: its one commit takes its identity from the env. */
function initAnonymousRepo(dir: string) {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  execFileSync("git", ["commit", "-q", "-m", "initial"], {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "source",
      GIT_AUTHOR_EMAIL: "source@example.com",
      GIT_COMMITTER_NAME: "source",
      GIT_COMMITTER_EMAIL: "source@example.com",
    },
  });
}

function packageFilesStatus(dir: string): string {
  return git(dir, "status", "--porcelain", "--", "package.json", "package-lock.json");
}

describe("installs that write a lockfile commit it", { timeout: 120_000 }, () => {
  it("a full-archive import that carries .git", async () => {
    const from = `icd-src-${process.pid}`;
    const to = `icd-dst-${process.pid}`;
    names.push(from, to);
    const src = mindDir(from);
    mkdirSync(resolve(src, "home"), { recursive: true });
    writeFileSync(resolve(src, "home/SOUL.md"), "# Soul\n");
    writeFileSync(resolve(src, "package.json"), `{"name":"${from}","private":true}\n`);
    const out = mkdtempSync(resolve(tmpdir(), "icd-archive-"));
    scratch.push(out);
    const path = resolve(out, "m.volute");
    createExportArchive({ name: from, template: "claude", includeSrc: true }).writeZip(path);
    const tempDir = mkdtempSync(resolve(tmpdir(), "icd-extract-"));
    scratch.push(tempDir);
    const { manifest } = extractArchive(path, tempDir);
    // Exports leave .git out; an archive made by hand, or by an older export, has one —
    // and its config may name no one, which under isolation (no gitconfig in HOME) fails
    // the commit, and on a host with one attributes it to the host.
    initAnonymousRepo(resolve(tempDir, "mind"));

    const result = await importMindFromArchive(tempDir, to, manifest);
    assert.ok(result.ok, JSON.stringify(result));

    const dir = mindDir(to);
    assert.ok(existsSync(resolve(dir, "package-lock.json")), "npm install ran");
    assert.equal(packageFilesStatus(dir), "", "the install's changes are committed");
    assert.equal(
      git(
        dir,
        "log",
        "-1",
        "--format=%an <%ae>",
        "--grep=^Update dependencies after import$",
      ).trim(),
      `${to} <${to}.local@volute.systems>`,
      "committed as the imported mind",
    );
  });

  it("a split", async () => {
    const parent = `icd-parent-${process.pid}`;
    const variant = `icd-variant-${process.pid}`;
    names.push(parent);
    const dir = mindDir(parent);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "package.json"), `{"name":"${parent}","private":true}\n`);
    writeFileSync(resolve(dir, ".gitignore"), "node_modules/\n.variants/\n");
    initRepo(dir);
    await addMind(parent, 4197, undefined, "claude");

    const result = await createVariant({
      parentName: parent,
      projectRoot: dir,
      variantName: variant,
      noStart: true,
    });
    assert.ok(result.ok, JSON.stringify(result));
    names.push(variant);

    const variantDir = resolve(dir, ".variants", variant);
    assert.ok(existsSync(resolve(variantDir, "package-lock.json")), "npm install ran");
    assert.equal(packageFilesStatus(variantDir), "", "the install's changes are committed");
    assert.equal(
      git(variantDir, "log", "-1", "--format=%s").trim(),
      "Update dependencies after split",
    );
    assert.equal(packageFilesStatus(dir), "", "the parent's tree is untouched");
  });
});
