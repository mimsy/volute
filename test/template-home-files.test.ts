import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  applyTemplateHomeFiles,
  isKnownTemplate,
} from "../packages/daemon/src/lib/template/template.js";

describe("applyTemplateHomeFiles", () => {
  let mindDir: string;
  let homeDir: string;

  beforeEach(() => {
    mindDir = resolve(tmpdir(), `volute-home-test-${process.pid}-${Date.now()}`);
    homeDir = resolve(mindDir, "home");
    // Seed a claude-shaped home/.
    mkdirSync(resolve(homeDir, ".claude"), { recursive: true });
    mkdirSync(resolve(homeDir, ".config"), { recursive: true });
    writeFileSync(resolve(homeDir, "CLAUDE.md"), "old claude mechanics");
    writeFileSync(resolve(homeDir, ".claude", "settings.json"), "{}");
    writeFileSync(
      resolve(homeDir, ".config", "config.json"),
      JSON.stringify({ model: "claude-opus-4-6" }),
    );
    // Mind-authored files that must survive (including siblings of config.json).
    writeFileSync(resolve(homeDir, "SOUL.md"), "my soul");
    writeFileSync(resolve(homeDir, "MEMORY.md"), "my memory");
    writeFileSync(resolve(homeDir, ".config", "volute.json"), '{"identity":"keep"}');
    mkdirSync(resolve(homeDir, "memory", "journal"), { recursive: true });
    writeFileSync(resolve(homeDir, "memory", "journal", "2026-01-01.md"), "day one");
  });

  afterEach(() => {
    rmSync(mindDir, { recursive: true, force: true });
  });

  it("swaps claude → pi: replaces mechanics doc, drops settings, resets model", async () => {
    await applyTemplateHomeFiles(mindDir, "pi", null);

    assert.ok(!existsSync(resolve(homeDir, "CLAUDE.md")), "CLAUDE.md removed");
    assert.ok(existsSync(resolve(homeDir, "MINDS.md")), "MINDS.md added");
    assert.ok(!existsSync(resolve(homeDir, "AGENTS.md")));
    assert.ok(
      !existsSync(resolve(homeDir, ".claude", "settings.json")),
      ".claude/settings.json removed",
    );

    const cfg = JSON.parse(readFileSync(resolve(homeDir, ".config", "config.json"), "utf-8"));
    assert.notEqual(cfg.model, "claude-opus-4-6");
    assert.ok(String(cfg.model).startsWith("openrouter:"), `pi model, got ${cfg.model}`);

    // Mind-authored files untouched — including config.json's siblings.
    assert.equal(readFileSync(resolve(homeDir, "SOUL.md"), "utf-8"), "my soul");
    assert.equal(readFileSync(resolve(homeDir, "MEMORY.md"), "utf-8"), "my memory");
    assert.equal(
      readFileSync(resolve(homeDir, ".config", "volute.json"), "utf-8"),
      '{"identity":"keep"}',
    );
    assert.equal(
      readFileSync(resolve(homeDir, "memory", "journal", "2026-01-01.md"), "utf-8"),
      "day one",
    );
  });

  it("swaps claude → codex: adds AGENTS.md and codex config", async () => {
    await applyTemplateHomeFiles(mindDir, "codex", null);

    assert.ok(!existsSync(resolve(homeDir, "CLAUDE.md")));
    assert.ok(existsSync(resolve(homeDir, "AGENTS.md")), "AGENTS.md added");
    assert.ok(!existsSync(resolve(homeDir, ".claude", "settings.json")));

    const cfg = JSON.parse(readFileSync(resolve(homeDir, ".config", "config.json"), "utf-8"));
    assert.ok("reasoningEffort" in cfg, "codex config has reasoningEffort");
    assert.ok(String(cfg.model).startsWith("gpt"), `codex model, got ${cfg.model}`);
  });

  it("swaps pi → claude: restores CLAUDE.md, settings, claude model", async () => {
    // Start from a pi-shaped home.
    await applyTemplateHomeFiles(mindDir, "pi", null);
    assert.ok(existsSync(resolve(homeDir, "MINDS.md")));

    await applyTemplateHomeFiles(mindDir, "claude", null);

    assert.ok(existsSync(resolve(homeDir, "CLAUDE.md")), "CLAUDE.md restored");
    assert.ok(!existsSync(resolve(homeDir, "MINDS.md")), "MINDS.md removed");
    assert.ok(
      existsSync(resolve(homeDir, ".claude", "settings.json")),
      ".claude/settings.json restored",
    );

    const cfg = JSON.parse(readFileSync(resolve(homeDir, ".config", "config.json"), "utf-8"));
    assert.ok(String(cfg.model).startsWith("claude"), `claude model, got ${cfg.model}`);
  });

  it("throws on an unknown template without deleting the existing mechanics doc", async () => {
    await assert.rejects(applyTemplateHomeFiles(mindDir, "bogus", null), /mechanics doc/i);
    // Atomicity: the destructive swap must not have started.
    assert.ok(existsSync(resolve(homeDir, "CLAUDE.md")), "CLAUDE.md preserved on failure");
  });

  // The mind owns home/ and the daemon is root under user isolation: a link planted at
  // one of these names must be replaced, never written through or deleted through (#1264).
  describe("with links the mind planted", () => {
    let outside: string;
    beforeEach(() => {
      outside = mkdtempSync(join(tmpdir(), "volute-home-outside-"));
      writeFileSync(join(outside, "victim"), "host file");
    });
    afterEach(() => rmSync(outside, { recursive: true, force: true }));

    it("replaces a link at a file it writes instead of writing through it", async () => {
      symlinkSync(join(outside, "victim"), resolve(homeDir, "AGENTS.md"));
      rmSync(resolve(homeDir, ".config", "config.json"));
      symlinkSync(join(outside, "victim"), resolve(homeDir, ".config", "config.json"));

      await applyTemplateHomeFiles(mindDir, "codex", null);

      assert.equal(readFileSync(join(outside, "victim"), "utf-8"), "host file");
      for (const rel of ["AGENTS.md", ".config/config.json"]) {
        assert.ok(lstatSync(resolve(homeDir, rel)).isFile(), `${rel} is a regular file now`);
      }
    });

    it("removes a link at an old mechanics doc's name, leaving its target alone", async () => {
      // A link left at CLAUDE.md would keep the home reading as claude after the switch.
      rmSync(resolve(homeDir, "CLAUDE.md"));
      symlinkSync(join(outside, "victim"), resolve(homeDir, "CLAUDE.md"));

      await applyTemplateHomeFiles(mindDir, "pi", null);

      assert.equal(lstatSync(resolve(homeDir, "CLAUDE.md"), { throwIfNoEntry: false }), undefined);
      assert.equal(readFileSync(join(outside, "victim"), "utf-8"), "host file");
    });

    it("refuses a directory linked out of the tree, writing nothing there", async () => {
      // pi → claude writes .claude/settings.json; .claude points at the host's dir.
      rmSync(resolve(homeDir, ".claude"), { recursive: true });
      symlinkSync(outside, resolve(homeDir, ".claude"));

      await assert.rejects(applyTemplateHomeFiles(mindDir, "claude", null));
      assert.ok(!existsSync(join(outside, "settings.json")), "nothing written through the link");
    });

    it("never deletes through a directory linked out of the tree", async () => {
      // claude → pi removes .claude/settings.json; .claude points at the host's dir.
      writeFileSync(join(outside, "settings.json"), "host settings");
      rmSync(resolve(homeDir, ".claude"), { recursive: true });
      symlinkSync(outside, resolve(homeDir, ".claude"));

      await applyTemplateHomeFiles(mindDir, "pi", null).catch(() => {});
      assert.equal(readFileSync(join(outside, "settings.json"), "utf-8"), "host settings");
    });
  });
});

describe("isKnownTemplate", () => {
  it("accepts built-in templates and rejects others", () => {
    assert.ok(isKnownTemplate("claude"));
    assert.ok(isKnownTemplate("pi"));
    assert.ok(isKnownTemplate("codex"));
    assert.ok(!isKnownTemplate("bogus"));
    assert.ok(!isKnownTemplate("../../evil"));
  });
});
