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
import { resolve, sep } from "node:path";
import { describe, it } from "node:test";
import {
  initLedgerPath,
  readInitLedger,
  seedInitLedger,
} from "../packages/daemon/src/lib/mind/init-ledger.js";
import { stateDir } from "../packages/daemon/src/lib/mind/registry.js";
import {
  applyInitFiles,
  backfillInitInfrastructure,
  composeTemplate,
  copyTemplateToDir,
  findTemplatesRoot,
  isInitInfrastructure,
  listFiles,
  listInfrastructureOnDisk,
  mayRefreshInfrastructure,
  mergeManifests,
  readShippedHashes,
  SHIPPED_HASHES_REL,
  sha256,
} from "../packages/daemon/src/lib/template/template.js";

const TEMPLATES = ["claude", "pi", "codex"] as const;

/**
 * The pre-#900 `notices.ts` — the exact bytes every mind created before 0.58.0
 * still has on disk, calling the removed `/api/minds/` path.
 *
 * Checked in as a fixture rather than recovered from git: CI's unit-test job
 * checks out at `fetch-depth: 1`, so `git cat-file` on a historical blob is
 * absent there and the test would throw. `preNoticesHook()` asserts the
 * fixture's hash against the ledger entry, so it cannot silently drift from
 * what those minds actually carry.
 */
const PRE_0_58_NOTICES_SHA = "1b2fffd2f3fd9f00638d561c99f90b8b73a9aeb2beec923cbafbd7c83b9037f6";

function preNoticesHook(): string {
  const content = readFileSync(
    resolve(import.meta.dirname, "fixtures/pre-0.58-notices.ts.txt"),
    "utf-8",
  );
  assert.equal(sha256(content), PRE_0_58_NOTICES_SHA, "the pre-0.58.0 fixture has drifted");
  assert.match(content, /\/api\/minds\//, "the fixture must be the broken version");
  return content;
}

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
  ".local/hooks/pre-prompt/turn-context.ts": "infrastructure",
  // Volute's bookkeeping, not a file any mind runs: the ledger of every hash
  // this subtree has ever shipped. It lives here so that adding a `.local/` file
  // cannot happen without this test seeing it, and composeTemplate strips it
  // from the composed output so it never reaches a mind's home/ (asserted below).
  ".local/SHIPPED.json": "infrastructure",
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

  /**
   * A mind directory as `volute mind create` left it *before* the ledger existed
   * — the state every mind on a running host is in the moment this ships. No
   * ledger, so absence is still ambiguous on the first run.
   */
  function createdMind(name: string): string {
    const dir = resolve(scratch(), name);
    rmSync(stateDir(name), { recursive: true, force: true });
    const { composedDir, manifest } = composeTemplate(templatesRoot, "claude");
    copyTemplateToDir(composedDir, dir, name, manifest);
    applyInitFiles(dir);
    return resolve(dir, "home");
  }

  it("adds nothing to a mind created from the current template", () => {
    const home = createdMind("fresh");
    const { added } = backfillInitInfrastructure(home, "claude", "fresh");
    assert.deepEqual(added, [], "a current mind should already have every infrastructure file");
  });

  it("restores an infrastructure file the mind never had", () => {
    const home = createdMind("deaf");
    const hook = resolve(home, ".local/hooks/pre-prompt/notices.ts");
    // Model a mind created before the hook existed: it simply isn't there.
    rmSync(hook, { force: true });
    assert.ok(!existsSync(hook));

    const { added } = backfillInitInfrastructure(home, "claude", "deaf");

    assert.ok(added.includes(".local/hooks/pre-prompt/notices.ts"), `added: ${added.join(", ")}`);
    assert.ok(existsSync(hook), "the drain hook must be back on disk");
    assert.match(readFileSync(hook, "utf-8"), /history\/notices/);
  });

  it("recreates the whole .local tree when it is missing entirely", () => {
    // The state the production minds were actually in: no home/.local at all.
    const home = createdMind("nolocal");
    rmSync(resolve(home, ".local"), { recursive: true, force: true });

    const { added } = backfillInitInfrastructure(home, "claude", "nolocal");

    assert.ok(added.includes(".local/hooks/pre-prompt/notices.ts"));
    assert.ok(added.includes(".local/bin/volute"));
    assert.ok(existsSync(resolve(home, ".local/hooks/pre-prompt/notices.ts")));
    assert.ok(existsSync(resolve(home, ".local/bin/volute")));
  });

  it("never overwrites an infrastructure file the mind has edited", () => {
    const home = createdMind("tinkerer");
    const hook = resolve(home, ".local/hooks/pre-prompt/notices.ts");
    writeFileSync(hook, "// I rewrote this myself\n");

    const { added } = backfillInitInfrastructure(home, "claude", "tinkerer");

    assert.ok(!added.includes(".local/hooks/pre-prompt/notices.ts"));
    assert.equal(readFileSync(hook, "utf-8"), "// I rewrote this myself\n");
  });

  it("respects an emptied hook — the other way to decline one", () => {
    // Emptying a hook was the only way to decline one before the ledger, and
    // minds were told to do it, so it must keep working forever. hook-loader
    // skips an empty script outright; before that it ran it as a no-op (exit 0,
    // empty stdout -> {}). Either way the mind's "not this one" is respected.
    const home = createdMind("decliner");
    const hook = resolve(home, ".local/hooks/pre-prompt/notices.ts");
    writeFileSync(hook, "");

    const { added } = backfillInitInfrastructure(home, "claude", "decliner");

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

    const { added } = backfillInitInfrastructure(home, "claude", "stripped");

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

    const { added: first } = backfillInitInfrastructure(home, "claude", "twice");
    const { added: second } = backfillInitInfrastructure(home, "claude", "twice");

    assert.ok(first.length > 0);
    assert.deepEqual(second, [], "a second run must add nothing");
  });

  it("substitutes {{name}} in backfilled files and leaves no placeholder behind", () => {
    const home = createdMind("named");
    rmSync(resolve(home, ".local"), { recursive: true, force: true });

    const { added } = backfillInitInfrastructure(home, "claude", "named");

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

    const { added } = backfillInitInfrastructure(home, "claude", "bare");

    assert.ok(added.includes(".local/hooks/pre-prompt/notices.ts"));
    assert.ok(existsSync(resolve(home, ".local/hooks/pre-prompt/notices.ts")));
  });

  for (const template of TEMPLATES) {
    it(`delivers the drain hook for the ${template} template`, () => {
      const home = resolve(scratch(), `home-${template}`);
      mkdirSync(home, { recursive: true });
      // A distinct name per template: the ledger is per-mind and durable, so
      // three templates sharing one name would have the second run reading the
      // first's record and withholding the hook as a deliberate removal.
      const { added } = backfillInitInfrastructure(home, template, `any-${template}`);
      assert.ok(
        added.includes(".local/hooks/pre-prompt/notices.ts"),
        `${template} must ship the drain hook`,
      );
    });
  }
});

describe("the shipped-hash ledger", () => {
  const templatesRoot = findTemplatesRoot();

  it("lists the current hash of every .init/.local file the templates ship", () => {
    // The forcing function. `backfillInitInfrastructure` can only refresh a file
    // whose on-disk bytes it recognises as Volute's, so every version we have
    // ever shipped has to be in the ledger — including the one shipping right
    // now, which becomes "a previous version" the moment this release lands.
    // Editing a `.init/.local/` file without appending its new hash here means
    // the next release cannot repair the minds carrying it.
    const shipped = readShippedHashes(templatesRoot);
    for (const template of TEMPLATES) {
      const { composedDir } = composeTemplate(templatesRoot, template);
      for (const file of listFiles(resolve(composedDir, ".init"))) {
        if (!isInitInfrastructure(file)) continue;
        const hash = sha256(readFileSync(resolve(composedDir, ".init", file)));
        assert.ok(
          shipped[file]?.includes(hash),
          `${file} (${template} template) is not in ${SHIPPED_HASHES_REL}. Append its new ` +
            `sha256 ${hash} to the list for "${file}" — the old hashes must stay, they are how ` +
            `an upgrade recognises a mind still carrying a previous release's copy.`,
        );
      }
    }
  });

  it("keeps the pre-0.58.0 hooks recognisable — the minds this exists for", () => {
    // The specimen: #900 collapsed the API to /api/v1 and every mind that already
    // existed kept the /api/minds/ version of these hooks. If these hashes are ever
    // dropped from the ledger, those minds become unfixable by upgrade.
    const shipped = readShippedHashes(templatesRoot);
    const pre900: Record<string, string> = {
      ".local/hooks/pre-prompt/notices.ts":
        "1b2fffd2f3fd9f00638d561c99f90b8b73a9aeb2beec923cbafbd7c83b9037f6",
      ".local/hooks/pre-prompt/session-activity.ts":
        "da3f234001f7d1b640d48eb3ebb1cc5603c31949e189c5b05a56fd3229b53baa",
      ".local/hooks/pre-prompt/turn-context.ts":
        "0582eba89c045d234773cf517b0c3e32e11acce7504474ac15f31901c1c6d418",
      ".local/hooks/startup-context.ts":
        "04dae0cc44efe59184fad489d00aa405bb173e7bcefc864fa9e88812334cbdec",
    };
    for (const [file, hash] of Object.entries(pre900)) {
      assert.ok(shipped[file]?.includes(hash), `${file} lost its pre-0.58.0 hash ${hash}`);
    }
  });

  it("never reaches a mind's home/", () => {
    // It is Volute's bookkeeping. composeTemplate strips it, which is the single
    // exclusion point covering copyTemplateToDir, applyInitFiles and the backfill.
    assert.ok(
      existsSync(resolve(templatesRoot, "_base", SHIPPED_HASHES_REL)),
      "the ledger must exist in the source tree",
    );

    for (const template of TEMPLATES) {
      const { composedDir, manifest } = composeTemplate(templatesRoot, template);
      assert.ok(
        !existsSync(resolve(composedDir, SHIPPED_HASHES_REL)),
        `${template}: the ledger must be stripped from the composed template`,
      );

      const dir = resolve(scratch(), `mind-${template}`);
      copyTemplateToDir(composedDir, dir, `mind-${template}`, manifest);
      applyInitFiles(dir);
      assert.ok(!existsSync(resolve(dir, "home/.local/SHIPPED.json")));
      assert.ok(!existsSync(resolve(dir, ".init")));
    }
  });

  it("keeps every .local/ file out of manifest substitution", () => {
    // Hashes in the ledger are of the raw shipped bytes. A `.local/` file listed
    // in `substitute` would be rendered per-mind, so its on-disk bytes could never
    // match a ledger hash and it would silently stop being refreshable. If a
    // `.local/` file ever genuinely needs {{name}}, the ledger has to start
    // storing rendered hashes — this assert is the reminder, not a rule to delete.
    for (const template of TEMPLATES) {
      const base = JSON.parse(
        readFileSync(resolve(templatesRoot, "_base", "volute-template.json"), "utf-8"),
      );
      const own = resolve(templatesRoot, template, "volute-template.json");
      const merged = mergeManifests(
        base,
        existsSync(own) ? JSON.parse(readFileSync(own, "utf-8")) : {},
      );
      for (const path of merged.substitute) {
        assert.ok(
          !path.startsWith(".init/.local/"),
          `${path} is substituted per-mind, so the backfill could never refresh it`,
        );
      }
    }
  });
});

describe("backfillInitInfrastructure: a deletion the mind meant", () => {
  const templatesRoot = findTemplatesRoot();
  const NOTICES = ".local/hooks/pre-prompt/notices.ts";

  function createdMind(name: string, seed: boolean): string {
    const dir = resolve(scratch(), name);
    rmSync(stateDir(name), { recursive: true, force: true });
    const { composedDir, manifest } = composeTemplate(templatesRoot, "claude");
    copyTemplateToDir(composedDir, dir, name, manifest);
    const applied = applyInitFiles(dir);
    if (seed) seedInitLedger(name, applied);
    return resolve(dir, "home");
  }

  it("seeds the ledger at creation with infrastructure only", () => {
    createdMind("seeded", true);
    const ledger = readInitLedger("seeded");

    assert.ok(ledger.has(NOTICES), "the drain hook must be recorded as given");
    for (const rel of ledger) {
      assert.ok(isInitInfrastructure(rel), `${rel} is identity and must not be in the ledger`);
    }
    for (const rel of ["SOUL.md", "MEMORY.md", ".config/routes.json"]) {
      assert.ok(!ledger.has(rel), `${rel} must never be recorded as framework-given`);
    }
  });

  it("leaves a hook the mind deleted deleted", () => {
    // The whole point of #811. A mind that removes a piece of machinery has
    // authored that removal, and the daemon's confidence that the machinery is
    // good for it does not outrank the removal.
    const home = createdMind("refuser", true);
    rmSync(resolve(home, NOTICES));

    const { added, refreshed, withheld } = backfillInitInfrastructure(home, "claude", "refuser");

    assert.ok(withheld.includes(NOTICES), "a deliberate removal must be reported as withheld");
    assert.ok(!added.includes(NOTICES));
    assert.ok(!refreshed.includes(NOTICES));
    assert.equal(existsSync(resolve(home, NOTICES)), false, "the hook must stay gone");
  });

  it("keeps honouring the removal on every later run", () => {
    // Property 1 of the issue: the removal is durable. It must not need re-doing
    // after each restart — for the spirit, the backfill runs every daemon start.
    const home = createdMind("persistent", true);
    rmSync(resolve(home, NOTICES));

    for (let run = 0; run < 3; run++) {
      const { withheld } = backfillInitInfrastructure(home, "claude", "persistent");
      assert.ok(withheld.includes(NOTICES), `run ${run} put the hook back`);
      assert.equal(existsSync(resolve(home, NOTICES)), false);
    }
  });

  it("still adds a hook the mind was never given", () => {
    // The #808 regression guard, and the reason the ledger is seeded from what is
    // on disk rather than from the full shipped set: a mind that legitimately
    // never had the drain hook must still get it, or it stays deaf to every
    // next-turn notice recorded for it.
    const home = createdMind("newcomer", true);
    rmSync(resolve(home, NOTICES));
    // A mind predating the hook has no ledger entry for it either.
    seedInitLedger(
      "newcomer",
      [...readInitLedger("newcomer")].filter((p) => p !== NOTICES),
    );

    const { added, withheld } = backfillInitInfrastructure(home, "claude", "newcomer");

    assert.ok(added.includes(NOTICES), "a hook never given must still be delivered");
    assert.deepEqual(withheld, []);
    assert.ok(existsSync(resolve(home, NOTICES)));
  });

  it("undoes a removal made before the ledger existed exactly once", () => {
    // The one-time cost of seeding from disk, stated plainly: every mind alive
    // when this ships has no ledger, so its first run cannot tell a pre-existing
    // removal from "never had it" and re-adds the file. The second removal is
    // durable, which is the property the mind actually needs.
    const home = createdMind("legacy", false);
    rmSync(resolve(home, NOTICES));

    const first = backfillInitInfrastructure(home, "claude", "legacy");
    assert.ok(first.added.includes(NOTICES), "the pre-ledger removal comes back once");
    assert.ok(readInitLedger("legacy").has(NOTICES), "and is recorded when it does");

    rmSync(resolve(home, NOTICES));
    const second = backfillInitInfrastructure(home, "claude", "legacy");
    assert.ok(second.withheld.includes(NOTICES), "the second removal must stick");
    assert.equal(existsSync(resolve(home, NOTICES)), false);
  });

  it("never records a path whose file is not on disk", () => {
    // The safety invariant. An entry for a file that never landed reads as
    // "given, then removed" and would withhold that file from the mind forever.
    const home = createdMind("invariant", false);
    rmSync(resolve(home, ".local"), { recursive: true, force: true });

    backfillInitInfrastructure(home, "claude", "invariant");

    const ledger = readInitLedger("invariant");
    assert.ok(ledger.size > 0);
    for (const rel of ledger) {
      assert.ok(existsSync(resolve(home, rel)), `${rel} was recorded but never landed`);
    }
  });

  it("re-adds a withheld file when the caller says the absence is its own fault", () => {
    // An upgrade whose restore of merge-deleted home/ files threw partway leaves
    // .local/ files missing for a reason that has nothing to do with the mind.
    // Reading that as authorship would withhold them permanently and silently —
    // #808 all over again. One extra deletion for the mind is the cheaper error.
    const home = createdMind("damaged", true);
    rmSync(resolve(home, NOTICES));

    const honoured = backfillInitInfrastructure(home, "claude", "damaged");
    assert.ok(honoured.withheld.includes(NOTICES), "the default must honour the removal");

    const repaired = backfillInitInfrastructure(home, "claude", "damaged", {
      honorRemovals: false,
    });
    assert.ok(repaired.added.includes(NOTICES));
    assert.deepEqual(repaired.withheld, []);
    assert.ok(existsSync(resolve(home, NOTICES)));
  });

  it("reads a mind's infrastructure off disk for creation paths that compose no template", () => {
    // importFromFullArchive copies an extracted archive wholesale. The archive
    // carries the absence of a hook the mind deleted before export, and this is
    // what lets that absence be recorded rather than undone on the new host.
    const home = createdMind("archived", false);
    rmSync(resolve(home, NOTICES));

    const onDisk = listInfrastructureOnDisk(home);

    assert.ok(onDisk.length > 0);
    assert.ok(!onDisk.includes(NOTICES), "a deleted hook must not be reported as present");
    assert.ok(onDisk.includes(".local/hooks/startup-context.ts"));
    for (const rel of onDisk) {
      assert.ok(isInitInfrastructure(rel), `${rel} is not infrastructure`);
      assert.ok(existsSync(resolve(home, rel)));
    }
  });

  it("degrades to adding, and rewrites itself, when the ledger is corrupt", () => {
    // Same posture as readShippedHashes: an unreadable ledger costs one re-add,
    // not a mind permanently withheld from its own infrastructure.
    const home = createdMind("corrupt", true);
    rmSync(resolve(home, NOTICES));
    writeFileSync(initLedgerPath("corrupt"), "{ not json");

    const { added } = backfillInitInfrastructure(home, "claude", "corrupt");

    assert.ok(added.includes(NOTICES));
    assert.ok(readInitLedger("corrupt").has(NOTICES), "the ledger must repair itself");
  });

  it("does not inherit a previous mind's ledger when the name is reused", () => {
    // A mind deleted and recreated under the same name is a new mind, and must
    // not arrive already refusing things the old one refused. Creation replaces
    // the ledger rather than merging into it.
    const retired = ".local/hooks/pre-prompt/gone.ts";
    rmSync(stateDir("recycled"), { recursive: true, force: true });
    seedInitLedger("recycled", [NOTICES, retired]);

    // `volute mind create` again, without clearing the state dir first.
    const dir = resolve(scratch(), "recycled");
    const { composedDir, manifest } = composeTemplate(templatesRoot, "claude");
    copyTemplateToDir(composedDir, dir, "recycled", manifest);
    seedInitLedger("recycled", applyInitFiles(dir));

    const ledger = readInitLedger("recycled");
    assert.ok(ledger.has(NOTICES), "the new mind's own files are recorded");
    assert.ok(!ledger.has(retired), "the old mind's ledger must not survive");
  });
});

describe("every creation path seeds the ledger", () => {
  /**
   * The forcing function for the wiring, and the reason it needs one: a creation
   * path that copies `.init/` without recording what it gave has a mind whose
   * removals are read as "never had it" until its first backfill — silently, and
   * only for minds made that way. That is the #808 failure shape exactly (a
   * daemon-side half that ships and looks healthy), so the fifth creation path
   * someone adds must fail here rather than in a mind's home directory.
   */
  it("seeds the ledger in every function that creates a mind directory", () => {
    // The applyInitFiles check below cannot see importFromFullArchive: it copies
    // an extracted archive wholesale and composes no template, so it has no
    // applyInitFiles call to wrap and the check passes over it vacuously — which
    // is exactly how it shipped unseeded in review. Every creation path in
    // lifecycle.ts is marked by the same 409 guard, so split on that instead and
    // require a seed in each.
    const src = readFileSync(
      resolve(import.meta.dirname, "../packages/daemon/src/lib/mind/lifecycle.ts"),
      "utf-8",
    );
    const guard = 'error: "Mind directory already exists"';
    const paths = src.split(guard).slice(1);

    assert.equal(paths.length, 4, "the known creation paths in lifecycle.ts");
    for (const [i, body] of paths.entries()) {
      assert.ok(
        body.includes("seedInitLedger("),
        `creation path ${i + 1} of ${paths.length} never records what it gave the mind`,
      );
    }
  });

  it("calls applyInitFiles only as an argument to seedInitLedger", () => {
    const root = resolve(import.meta.dirname, "../packages/daemon/src");
    const callers: string[] = [];

    for (const rel of listFiles(root)) {
      if (!rel.endsWith(".ts")) continue;
      const path = resolve(root, rel);
      // template.ts declares applyInitFiles; every other reference is a call.
      if (rel.endsWith(`template${sep}template.ts`)) continue;
      for (const line of readFileSync(path, "utf-8").split("\n")) {
        if (!line.includes("applyInitFiles(")) continue;
        if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) continue;
        if (line.includes("import")) continue;
        callers.push(`${rel}: ${line.trim()}`);
      }
    }

    assert.ok(callers.length >= 4, `expected the known creation paths, found ${callers.length}`);
    for (const caller of callers) {
      assert.match(
        caller,
        /seedInitLedger\([^,]+,\s*applyInitFiles\(/,
        `${caller}\n  — a creation path that applies .init/ must record what it gave`,
      );
    }
  });
});

describe("backfillInitInfrastructure: refreshing stale infrastructure", () => {
  const templatesRoot = findTemplatesRoot();

  function createdMind(name: string): string {
    const dir = resolve(scratch(), name);
    rmSync(stateDir(name), { recursive: true, force: true });
    const { composedDir, manifest } = composeTemplate(templatesRoot, "claude");
    copyTemplateToDir(composedDir, dir, name, manifest);
    applyInitFiles(dir);
    return resolve(dir, "home");
  }

  it("replaces a hook the mind still has verbatim from an older release", () => {
    // The bug this PR exists for: bardo's minds carried the pre-#900
    // notices.ts, which calls the removed /api/minds/ path and 404s on every
    // turn, and `volute mind upgrade` would not touch it because it was
    // "already there". The fixture is the real historical bytes, hash-pinned.
    const rel = ".local/hooks/pre-prompt/notices.ts";
    const pre900 = preNoticesHook();

    const home = createdMind("stale");
    const hook = resolve(home, rel);
    const currentContent = readFileSync(hook, "utf-8");
    writeFileSync(hook, pre900);

    const { added, refreshed } = backfillInitInfrastructure(home, "claude", "stale");

    assert.deepEqual(added, [], "nothing was missing");
    assert.ok(refreshed.includes(rel), `expected ${rel} refreshed; got ${refreshed.join(", ")}`);
    assert.equal(readFileSync(hook, "utf-8"), currentContent);
    assert.match(readFileSync(hook, "utf-8"), /\/api\/v1\/minds\//);
  });

  it("refreshes only the stale files, leaving the mind's edits beside them", () => {
    const staleRel = ".local/hooks/pre-prompt/notices.ts";
    const ownRel = ".local/hooks/startup-context.ts";
    const pre900 = preNoticesHook();

    const home = createdMind("mixed");
    writeFileSync(resolve(home, staleRel), pre900);
    writeFileSync(resolve(home, ownRel), "// mine\n");

    const { refreshed } = backfillInitInfrastructure(home, "claude", "mixed");

    assert.deepEqual(refreshed, [staleRel]);
    assert.equal(readFileSync(resolve(home, ownRel), "utf-8"), "// mine\n");
  });

  it("is idempotent — a second pass refreshes nothing", () => {
    const rel = ".local/hooks/pre-prompt/notices.ts";
    const pre900 = preNoticesHook();

    const home = createdMind("twice2");
    writeFileSync(resolve(home, rel), pre900);

    assert.ok(backfillInitInfrastructure(home, "claude", "twice2").refreshed.includes(rel));
    assert.deepEqual(backfillInitInfrastructure(home, "claude", "twice2").refreshed, []);
  });

  it("keeps going when one .local/ path is unreadable", () => {
    // A directory where a file belongs (or a permission the daemon lost) is one
    // mind's one file. If it threw out of the loop, upgrade would log a single
    // warning and silently skip the *adds* for everything after it — which is
    // how a mind ends up missing the one hook this whole mechanism exists to
    // deliver.
    const home = createdMind("unreadable");
    const hook = resolve(home, ".local/hooks/pre-prompt/notices.ts");
    rmSync(hook, { force: true });
    mkdirSync(hook, { recursive: true }); // a directory in a file's place
    rmSync(resolve(home, ".local/bin/volute"), { force: true });

    const { added, refreshed } = backfillInitInfrastructure(home, "claude", "unreadable");

    assert.ok(added.includes(".local/bin/volute"), "later files must still be delivered");
    assert.ok(!refreshed.includes(".local/hooks/pre-prompt/notices.ts"));
  });

  it("leaves a current mind completely alone", () => {
    const home = createdMind("current");
    const { added, refreshed } = backfillInitInfrastructure(home, "claude", "current");
    assert.deepEqual(added, []);
    assert.deepEqual(refreshed, []);
  });

  it("never refreshes a file the mind edited", () => {
    const home = createdMind("author");
    const hook = resolve(home, ".local/hooks/pre-prompt/notices.ts");
    writeFileSync(hook, "// my own drain, thanks\n");

    const { refreshed } = backfillInitInfrastructure(home, "claude", "author");

    assert.deepEqual(refreshed, []);
    assert.equal(readFileSync(hook, "utf-8"), "// my own drain, thanks\n");
  });

  it("never refreshes an emptied hook — declining still works", () => {
    const home = createdMind("decliner2");
    const hook = resolve(home, ".local/hooks/pre-prompt/notices.ts");
    writeFileSync(hook, "");

    const { refreshed } = backfillInitInfrastructure(home, "claude", "decliner2");

    assert.deepEqual(refreshed, []);
    assert.equal(readFileSync(hook, "utf-8"), "");
  });

  it("degrades to add-only when the ledger is unreadable", () => {
    // A missing/corrupt ledger must not make the backfill refuse to run: adding
    // a hook a mind never had is the #808 fix and has to keep working.
    const shipped = readShippedHashes(resolve(scratch(), "no-templates-here"));
    assert.deepEqual(shipped, {});
  });
});

describe("mayRefreshInfrastructure", () => {
  const SHIPPED_A = sha256("v1");
  const SHIPPED_B = sha256("v2");
  const ledger = [SHIPPED_A, SHIPPED_B];

  it("refreshes bytes we shipped in an earlier release", () => {
    assert.equal(mayRefreshInfrastructure("v1", "v2", ledger), true);
  });

  it("leaves bytes we never shipped alone", () => {
    // The guarantee the whole mechanism rests on: if we didn't write it, it isn't ours.
    assert.equal(mayRefreshInfrastructure("mine", "v2", ledger), false);
  });

  it("leaves an emptied file alone", () => {
    assert.equal(mayRefreshInfrastructure("", "v2", ledger), false);
  });

  it("does nothing when the file is already current", () => {
    assert.equal(mayRefreshInfrastructure("v2", "v2", ledger), false);
  });

  it("leaves everything alone when the ledger has no entry for the path", () => {
    assert.equal(mayRefreshInfrastructure("v1", "v2", undefined), false);
    assert.equal(mayRefreshInfrastructure("v1", "v2", []), false);
  });

  it("compares bytes, not text — a trailing-newline change is a different file", () => {
    assert.equal(mayRefreshInfrastructure("v1\n", "v2", ledger), false);
  });
});
