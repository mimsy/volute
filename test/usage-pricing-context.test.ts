import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";
import { mindPricingContext } from "../packages/daemon/src/lib/daemon/usage-pricing.js";
import { addMind, addVariant, mindDir } from "../packages/daemon/src/lib/mind/registry.js";

const scratch = mkdtempSync(resolve(tmpdir(), "volute-pricing-ctx-"));

after(() => rmSync(scratch, { recursive: true, force: true }));

/** Write a mind's `home/.config/config.json` with the given model. */
function writeConfig(dir: string, model: string): void {
  mkdirSync(resolve(dir, "home/.config"), { recursive: true });
  writeFileSync(
    resolve(dir, "home/.config/config.json"),
    JSON.stringify({ model, compaction: { maxContextTokens: 150000 } }),
  );
}

describe("mindPricingContext", () => {
  it("reads the configured model from a plain mind's directory", async () => {
    await addMind("pc-plain", 4801, undefined, "claude");
    writeConfig(mindDir("pc-plain"), "claude-haiku-4-5");

    const ctx = await mindPricingContext("pc-plain");
    assert.equal(ctx.template, "claude");
    assert.equal(ctx.configuredModel, "claude-haiku-4-5");
  });

  it("honours the registry's dir for a variant in a worktree", async () => {
    // A variant's files live in a git worktree, not under the minds dir. Resolving by name
    // alone would miss the config and silently price the turn at the template default.
    await addMind("pc-parent", 4802, undefined, "claude");
    const worktree = resolve(scratch, "pc-variant-worktree");
    await addVariant("pc-variant", "pc-parent", 4803, worktree, "variant/pc");
    writeConfig(worktree, "claude-sonnet-4-5");
    // A decoy at the name-derived path proves the registry dir is what's read.
    writeConfig(mindDir("pc-variant"), "claude-opus-4-6");

    const ctx = await mindPricingContext("pc-variant");
    assert.equal(ctx.configuredModel, "claude-sonnet-4-5");
  });

  it("leaves the model undefined when no config is readable", async () => {
    await addMind("pc-nodir", 4804, undefined, "codex");
    const ctx = await mindPricingContext("pc-nodir");
    assert.equal(ctx.configuredModel, undefined);
    // The template still resolves, so pricing can fall back to the template default.
    assert.equal(ctx.template, "codex");
  });

  it("reports no template for a mind that is not registered", async () => {
    const ctx = await mindPricingContext("pc-does-not-exist");
    assert.equal(ctx.template, undefined);
    assert.equal(ctx.configuredModel, undefined);
  });
});
