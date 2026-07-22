import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import {
  applyInitFiles,
  composeTemplate,
  copyTemplateToDir,
  findTemplatesRoot,
} from "../packages/daemon/src/lib/template/template.js";

const tmpDir = mkdtempSync(join(tmpdir(), `.volute-dreams-test-${process.pid}-`));

after(() => rmSync(tmpDir, { recursive: true, force: true }));

/** Create a mind from `template` exactly the way mind creation does. */
function scaffold(template: string, mindName: string): string {
  const dest = join(tmpDir, `${mindName}-${template}`);
  const { composedDir, manifest } = composeTemplate(findTemplatesRoot(), template);
  try {
    copyTemplateToDir(composedDir, dest, mindName, manifest);
  } finally {
    rmSync(composedDir, { recursive: true, force: true });
  }
  applyInitFiles(dest);
  return dest;
}

/** True when `path` is excluded by the mind's .gitignore. */
function isIgnored(dir: string, path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", path], { cwd: dir });
    return true;
  } catch {
    // check-ignore exits non-zero when the path is not ignored.
    return false;
  }
}

/**
 * Dreams have one location: memory/dreams/ — the path the dreaming skill,
 * scripts/dream.ts and wake-context-dreams.sh all use, and the only one the
 * gitignore allowlist covers (via `!home/memory/**`).
 *
 * The skill used to say "create the directory if it doesn't exist", which
 * invites each mind to pick its own spot. One picked `dreams/`, where dreams
 * are unversioned — lost on a variant join — and invisible to `dream list`,
 * `read` and `themes`, which only ever look in memory/dreams/ (#799).
 */
describe("dreams have a single versioned location", () => {
  for (const template of ["pi", "claude", "codex"]) {
    it(`ships memory/dreams/ in the ${template} template and versions it`, () => {
      const dest = scaffold(template, `dreamtest-${template}`);
      const dreams = resolve(dest, "home", "memory", "dreams");

      // Shipping the directory removes the moment where a mind has to choose.
      assert.ok(existsSync(dreams), "memory/dreams/ must exist so dreams have a home");

      execFileSync("git", ["init", "-q"], { cwd: dest });
      writeFileSync(resolve(dreams, "2026-07-21.md"), "a dream\n");
      assert.ok(!isIgnored(dest, "home/memory/dreams/2026-07-21.md"));
    });
  }

  it("keeps the skill and its tooling on the same path", () => {
    const skillDir = resolve(import.meta.dirname, "..", "skills", "dreaming");
    const skill = readFileSync(resolve(skillDir, "SKILL.md"), "utf-8");
    const dreamScript = readFileSync(resolve(skillDir, "scripts", "dream.ts"), "utf-8");

    // The instruction handed to the dreamer must name memory/dreams/ and must
    // not tell it to create a directory — that is what let it choose one.
    assert.match(skill, /Write this dream to memory\/dreams\/YYYY-MM-DD\.md/);
    assert.doesNotMatch(skill, /create the directory if it doesn't exist/);

    // dream list/read/themes resolve against this exact path, so a dream
    // written anywhere else is invisible to the mind's own tools.
    assert.match(dreamScript, /const dreamsDir = resolve\("memory\/dreams"\)/);

    // Mind-facing paths are relative to home/, which is the mind's cwd — a
    // `home/` prefix here would resolve to home/home/.
    assert.doesNotMatch(skill, /home\/memory\/dreams/);
  });
});
