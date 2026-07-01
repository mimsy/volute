import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  applyTemplateHomeFiles,
  isKnownTemplate,
} from "../packages/daemon/src/lib/template/template.js";

describe("applyTemplateHomeFiles", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = resolve(tmpdir(), `volute-home-test-${process.pid}-${Date.now()}`);
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
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("swaps claude → pi: replaces mechanics doc, drops settings, resets model", () => {
    applyTemplateHomeFiles(homeDir, "pi");

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

  it("swaps claude → codex: adds AGENTS.md and codex config", () => {
    applyTemplateHomeFiles(homeDir, "codex");

    assert.ok(!existsSync(resolve(homeDir, "CLAUDE.md")));
    assert.ok(existsSync(resolve(homeDir, "AGENTS.md")), "AGENTS.md added");
    assert.ok(!existsSync(resolve(homeDir, ".claude", "settings.json")));

    const cfg = JSON.parse(readFileSync(resolve(homeDir, ".config", "config.json"), "utf-8"));
    assert.ok("reasoningEffort" in cfg, "codex config has reasoningEffort");
    assert.ok(String(cfg.model).startsWith("gpt"), `codex model, got ${cfg.model}`);
  });

  it("swaps pi → claude: restores CLAUDE.md, settings, claude model", () => {
    // Start from a pi-shaped home.
    applyTemplateHomeFiles(homeDir, "pi");
    assert.ok(existsSync(resolve(homeDir, "MINDS.md")));

    applyTemplateHomeFiles(homeDir, "claude");

    assert.ok(existsSync(resolve(homeDir, "CLAUDE.md")), "CLAUDE.md restored");
    assert.ok(!existsSync(resolve(homeDir, "MINDS.md")), "MINDS.md removed");
    assert.ok(
      existsSync(resolve(homeDir, ".claude", "settings.json")),
      ".claude/settings.json restored",
    );

    const cfg = JSON.parse(readFileSync(resolve(homeDir, ".config", "config.json"), "utf-8"));
    assert.ok(String(cfg.model).startsWith("claude"), `claude model, got ${cfg.model}`);
  });

  it("throws on an unknown template without deleting the existing mechanics doc", () => {
    assert.throws(() => applyTemplateHomeFiles(homeDir, "bogus"), /mechanics doc/i);
    // Atomicity: the destructive swap must not have started.
    assert.ok(existsSync(resolve(homeDir, "CLAUDE.md")), "CLAUDE.md preserved on failure");
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
