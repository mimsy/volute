import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  applyInitFiles,
  backfillInitInfrastructure,
  composeTemplate,
  copyTemplateToDir,
  findTemplatesRoot,
  isInitInfrastructure,
  listFiles,
} from "../packages/daemon/src/lib/template/template.js";

const TEMPLATES = ["claude", "pi", "codex"] as const;

function scratch(): string {
  return mkdtempSync(resolve(tmpdir(), "volute-init-class-"));
}

/**
 * Every `.init/` file each template actually ships, with the classification it is
 * expected to get. This list is the guard rail: a `.init/` file added at a new top
 * level fails here until someone decides, on purpose, whether a mind owns it.
 *
 * `.local/**` is infrastructure — Volute's machinery, which the mind did not author.
 * Everything else is the mind's own: what it is, what it remembers, how it is wired.
 */
const EXPECTED: Record<string, "identity" | "infrastructure"> = {
  "SOUL.md": "identity",
  "MEMORY.md": "identity",
  "CLAUDE.md": "identity",
  "MINDS.md": "identity",
  "AGENTS.md": "identity",
  "memory/journal/.gitkeep": "identity",
  "memory/dreams/.gitkeep": "identity",
  ".config/prompts.json": "identity",
  ".config/routes.json": "identity",
  ".claude/settings.json": "identity",
  ".local/bin/volute": "infrastructure",
  ".local/hooks/startup-context.ts": "infrastructure",
  ".local/hooks/wake-context.sh": "infrastructure",
  ".local/hooks/pre-prompt/notices.ts": "infrastructure",
  ".local/hooks/pre-prompt/session-activity.ts": "infrastructure",
};

describe("`.init/` identity vs infrastructure classification", () => {
  const templatesRoot = findTemplatesRoot();

  for (const template of TEMPLATES) {
    it(`classifies every .init/ file shipped by the ${template} template`, () => {
      const { composedDir } = composeTemplate(templatesRoot, template);
      const files = listFiles(resolve(composedDir, ".init"));

      assert.ok(files.length > 0, "template ships no .init/ files");
      for (const file of files) {
        const expected = EXPECTED[file];
        assert.ok(
          expected,
          `unclassified .init/ file "${file}" in the ${template} template. Decide whether a ` +
            `mind owns it (identity — never re-added) or Volute does (infrastructure — ` +
            `backfilled on upgrade), then add it to EXPECTED in this test.`,
        );
        const actual = isInitInfrastructure(file) ? "infrastructure" : "identity";
        assert.equal(actual, expected, `${file} classified ${actual}, expected ${expected}`);
      }
    });
  }

  it("treats the notices drain hook as infrastructure", () => {
    // The specific regression behind #808: this hook is the sole reader of the
    // next-turn event drain, and being identity-classified made every mind
    // created before it existed permanently deaf to system events.
    assert.equal(isInitInfrastructure(".local/hooks/pre-prompt/notices.ts"), true);
  });

  it("never classifies identity files as infrastructure", () => {
    for (const path of ["SOUL.md", "MEMORY.md", ".config/routes.json", "memory/journal/a.md"]) {
      assert.equal(isInitInfrastructure(path), false, `${path} must stay identity`);
    }
  });

  it("does not match a path that merely contains .local", () => {
    assert.equal(isInitInfrastructure("memory/.local-notes.md"), false);
    assert.equal(isInitInfrastructure("notes/.local/thing"), false);
  });
});

describe("backfillInitInfrastructure", () => {
  const templatesRoot = findTemplatesRoot();

  /** A mind directory as `volute mind create` leaves it. */
  function createdMind(name: string): string {
    const dir = resolve(scratch(), name);
    const { composedDir, manifest } = composeTemplate(templatesRoot, "claude");
    copyTemplateToDir(composedDir, dir, name, manifest);
    applyInitFiles(dir);
    return resolve(dir, "home");
  }

  it("adds nothing to a mind created from the current template", () => {
    const home = createdMind("fresh");
    const added = backfillInitInfrastructure(home, "claude", "fresh");
    assert.deepEqual(added, [], "a current mind should already have every infrastructure file");
  });

  it("restores an infrastructure file the mind never had", () => {
    const home = createdMind("deaf");
    const hook = resolve(home, ".local/hooks/pre-prompt/notices.ts");
    // Model a mind created before the hook existed: it simply isn't there.
    rmSync(hook, { force: true });
    assert.ok(!existsSync(hook));

    const added = backfillInitInfrastructure(home, "claude", "deaf");

    assert.ok(added.includes(".local/hooks/pre-prompt/notices.ts"), `added: ${added.join(", ")}`);
    assert.ok(existsSync(hook), "the drain hook must be back on disk");
    assert.match(readFileSync(hook, "utf-8"), /history\/notices/);
  });

  it("recreates the whole .local tree when it is missing entirely", () => {
    // The state the production minds were actually in: no home/.local at all.
    const home = createdMind("nolocal");
    rmSync(resolve(home, ".local"), { recursive: true, force: true });

    const added = backfillInitInfrastructure(home, "claude", "nolocal");

    assert.ok(added.includes(".local/hooks/pre-prompt/notices.ts"));
    assert.ok(added.includes(".local/bin/volute"));
    assert.ok(existsSync(resolve(home, ".local/hooks/pre-prompt/notices.ts")));
    assert.ok(existsSync(resolve(home, ".local/bin/volute")));
  });

  it("never overwrites an infrastructure file the mind has edited", () => {
    const home = createdMind("tinkerer");
    const hook = resolve(home, ".local/hooks/pre-prompt/notices.ts");
    writeFileSync(hook, "// I rewrote this myself\n");

    const added = backfillInitInfrastructure(home, "claude", "tinkerer");

    assert.ok(!added.includes(".local/hooks/pre-prompt/notices.ts"));
    assert.equal(readFileSync(hook, "utf-8"), "// I rewrote this myself\n");
  });

  it("respects an emptied hook — the documented way to decline one", () => {
    // The backfill cannot tell "predates this hook" from "deleted it on purpose",
    // so a deleted hook does come back. Emptying it is the escape hatch the doc
    // comment points minds at, and hook-loader treats an empty script as a no-op
    // (exit 0, empty stdout -> {}). That advice is only honest if this holds.
    const home = createdMind("decliner");
    const hook = resolve(home, ".local/hooks/pre-prompt/notices.ts");
    writeFileSync(hook, "");

    const added = backfillInitInfrastructure(home, "claude", "decliner");

    assert.ok(!added.includes(".local/hooks/pre-prompt/notices.ts"));
    assert.equal(readFileSync(hook, "utf-8"), "", "an emptied hook must stay empty");
  });

  it("never touches identity files, even when they are missing", () => {
    const home = createdMind("stripped");
    // A mind may legitimately have deleted these. The framework must not put
    // them back — a blank SOUL.md reappearing is worse than its absence.
    for (const rel of ["SOUL.md", "MEMORY.md", ".config/routes.json"]) {
      rmSync(resolve(home, rel), { force: true });
    }

    const added = backfillInitInfrastructure(home, "claude", "stripped");

    assert.deepEqual(added, []);
    for (const rel of ["SOUL.md", "MEMORY.md", ".config/routes.json"]) {
      assert.ok(!existsSync(resolve(home, rel)), `${rel} must not be restored`);
    }
  });

  it("keeps the volute shim executable", () => {
    const home = createdMind("shim");
    const shim = resolve(home, ".local/bin/volute");
    const originalMode = statSync(shim).mode;
    rmSync(shim, { force: true });

    backfillInitInfrastructure(home, "claude", "shim");

    assert.equal(statSync(shim).mode, originalMode);
    assert.ok(statSync(shim).mode & 0o111, "the shim must stay executable");
  });

  it("is idempotent", () => {
    const home = createdMind("twice");
    rmSync(resolve(home, ".local"), { recursive: true, force: true });

    const first = backfillInitInfrastructure(home, "claude", "twice");
    const second = backfillInitInfrastructure(home, "claude", "twice");

    assert.ok(first.length > 0);
    assert.deepEqual(second, [], "a second run must add nothing");
  });

  it("substitutes {{name}} in backfilled files and leaves no placeholder behind", () => {
    const home = createdMind("named");
    rmSync(resolve(home, ".local"), { recursive: true, force: true });

    const added = backfillInitInfrastructure(home, "claude", "named");

    for (const rel of added) {
      const content = readFileSync(resolve(home, rel), "utf-8");
      assert.ok(
        !content.includes("{{name}}"),
        `${rel} still carries an unsubstituted {{name}} placeholder`,
      );
    }
  });

  it("throws (never exits) when the template cannot be composed", () => {
    // composeTemplate/findTemplatesRoot process.exit(1) on a missing templates
    // root, template dir, or manifest. Both callers run inside the daemon, where
    // an uncatchable exit takes down every mind on the host — so the pre-checks
    // must turn those paths into a throw the caller can log and move past.
    const home = resolve(scratch(), "unknown-template-home");
    mkdirSync(home, { recursive: true });

    assert.throws(
      () => backfillInitInfrastructure(home, "no-such-template", "whoever"),
      /no-such-template/,
    );
  });

  it("creates missing parent directories", () => {
    const home = resolve(scratch(), "bare-home");
    mkdirSync(home, { recursive: true });

    const added = backfillInitInfrastructure(home, "claude", "bare");

    assert.ok(added.includes(".local/hooks/pre-prompt/notices.ts"));
    assert.ok(existsSync(resolve(home, ".local/hooks/pre-prompt/notices.ts")));
  });

  for (const template of TEMPLATES) {
    it(`delivers the drain hook for the ${template} template`, () => {
      const home = resolve(scratch(), `home-${template}`);
      mkdirSync(home, { recursive: true });
      const added = backfillInitInfrastructure(home, template, "any");
      assert.ok(
        added.includes(".local/hooks/pre-prompt/notices.ts"),
        `${template} must ship the drain hook`,
      );
    });
  }
});
