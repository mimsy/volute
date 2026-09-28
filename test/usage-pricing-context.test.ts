import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";
import {
  addCustomModel,
  removeAiConfig,
  removeCustomModel,
  saveProviderConfig,
} from "../packages/daemon/src/lib/ai-service.js";
import {
  mindModelId,
  mindPricingContext,
  priceUsageMetadata,
  resolveModelAlias,
} from "../packages/daemon/src/lib/daemon/usage-pricing.js";
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

describe("mindPricingContext: a variant inherits its parent's template", () => {
  it("prices a variant's turn instead of dropping it to null", async () => {
    // `addVariant` writes no `template`, so without the parent fallback a variant's
    // bare model id resolves to no provider, the turn prices to null, and its spend
    // counts $0 against the install-wide cap — a mind could split itself to spend
    // past its host's budget.
    await addMind("pc-tmpl-parent", 4811, undefined, "claude");
    const dir = resolve(scratch, "pc-tmpl-variant");
    mkdirSync(dir, { recursive: true });
    await addVariant("pc-tmpl-variant", "pc-tmpl-parent", 4812, dir, "variant-branch");

    const ctx = await mindPricingContext("pc-tmpl-variant");
    assert.equal(ctx.template, "claude", "falls back to the parent's template");

    const priced = priceUsageMetadata(
      {
        input_tokens: 1_000,
        output_tokens: 1_000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        model: "claude-haiku-4-5", // bare id, as the claude template emits
      },
      ctx,
    );
    assert.equal(
      priced.cost_usd,
      (1000 * 1 + 1000 * 5) / 1e6,
      "the variant's turn has a real cost",
    );
  });
});

describe("resolveModelAlias", () => {
  it("resolves an SDK alias to the newest catalog model in that family", () => {
    assert.equal(resolveModelAlias("haiku"), "anthropic:claude-haiku-4-5");
    assert.equal(resolveModelAlias("anthropic:sonnet"), "anthropic:claude-sonnet-5");
  });

  it("orders by version, not catalog order or string order", () => {
    // The catalog carries claude-opus-4-5 … 4-8, claude-opus-5 and claude-opus-5-5: major, then minor.
    assert.equal(resolveModelAlias("opus"), "anthropic:claude-opus-5-5");
    assert.equal(resolveModelAlias("fable"), "anthropic:claude-fable-5-1");
  });

  it("counts the host's custom models, so a model newer than the catalog wins", () => {
    addCustomModel("anthropic", "claude-opus-6");
    try {
      assert.equal(resolveModelAlias("opus"), "anthropic:claude-opus-6");
    } finally {
      removeCustomModel("anthropic", "claude-opus-6");
    }
  });

  it("passes anything that isn't an alias through unchanged", () => {
    assert.equal(resolveModelAlias("anthropic:claude-haiku-4-5"), "anthropic:claude-haiku-4-5");
    assert.equal(resolveModelAlias("openai-codex:gpt-5.4"), "openai-codex:gpt-5.4");
    assert.equal(resolveModelAlias("anthropic:nonesuch"), "anthropic:nonesuch");
  });

  it("mindModelId resolves a mind configured with an alias", async () => {
    await addMind("pc-alias", 4805, undefined, "claude");
    writeConfig(mindDir("pc-alias"), "haiku");
    assert.equal(await mindModelId("pc-alias"), "anthropic:claude-haiku-4-5");
  });
});

describe("mindModelId for a codex mind (#1228)", () => {
  // A codex mind's config.json carries a bare id; the mind thinks through the host's
  // openai-codex credentials, so that is where its summaries have to be written.
  it("resolves a bare id to openai-codex when that provider is configured", async () => {
    await addMind("pc-codex", 4806, undefined, "codex");
    writeConfig(mindDir("pc-codex"), "gpt-5.5");
    saveProviderConfig("openai-codex", { apiKey: "sk-test" });
    try {
      assert.equal(await mindModelId("pc-codex"), "openai-codex:gpt-5.5");
      // Pricing is untouched: the platform catalog prices the same model at the same rates.
      const priced = priceUsageMetadata(
        { model: "gpt-5.5", input_tokens: 1000, output_tokens: 100 },
        await mindPricingContext("pc-codex"),
      );
      assert.equal(priced.model, "openai:gpt-5.5");
    } finally {
      removeAiConfig();
    }
  });

  it("keeps openai for a bare id when openai-codex isn't configured", async () => {
    await addMind("pc-codex-openai", 4807, undefined, "codex");
    writeConfig(mindDir("pc-codex-openai"), "gpt-5.5");
    assert.equal(await mindModelId("pc-codex-openai"), "openai:gpt-5.5");
  });

  it("keeps a provider the mind's config names explicitly", async () => {
    await addMind("pc-codex-explicit", 4808, undefined, "codex");
    writeConfig(mindDir("pc-codex-explicit"), "openai:gpt-5.5");
    saveProviderConfig("openai-codex", { apiKey: "sk-test" });
    try {
      assert.equal(await mindModelId("pc-codex-explicit"), "openai:gpt-5.5");
    } finally {
      removeAiConfig();
    }
  });

  it("leaves a claude mind on anthropic", async () => {
    await addMind("pc-claude-codexhost", 4809, undefined, "claude");
    writeConfig(mindDir("pc-claude-codexhost"), "claude-haiku-4-5");
    saveProviderConfig("openai-codex", { apiKey: "sk-test" });
    try {
      assert.equal(await mindModelId("pc-claude-codexhost"), "anthropic:claude-haiku-4-5");
    } finally {
      removeAiConfig();
    }
  });
});
