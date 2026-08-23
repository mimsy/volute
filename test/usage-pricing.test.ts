import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  costOf,
  lookupRates,
  parseModelRef,
  priceUsageMetadata,
} from "../packages/daemon/src/lib/daemon/usage-pricing.js";

describe("parseModelRef", () => {
  it("splits a provider-prefixed id", () => {
    assert.deepEqual(parseModelRef("openrouter:moonshotai/kimi-k2.5"), {
      provider: "openrouter",
      id: "moonshotai/kimi-k2.5",
    });
  });

  it("takes the provider from the template for a bare id", () => {
    assert.deepEqual(parseModelRef("claude-opus-4-6", "claude"), {
      provider: "anthropic",
      id: "claude-opus-4-6",
    });
    assert.deepEqual(parseModelRef("gpt-5.4", "codex"), { provider: "openai", id: "gpt-5.4" });
  });

  it("keeps the id but leaves the provider undefined when it can't attribute one", () => {
    assert.deepEqual(parseModelRef("claude-opus-4-6"), {
      provider: undefined,
      id: "claude-opus-4-6",
    });
    // pi ids are always prefixed — a bare one is genuinely unattributable.
    assert.deepEqual(parseModelRef("some-model", "pi"), { provider: undefined, id: "some-model" });
  });

  it("does not split a colon that is not a provider separator", () => {
    // A Bedrock/Vertex deployment id ends in `:0`. Splitting it would mangle the id down to
    // "0" and stamp the mangled form into history for later surfaces to display.
    const ref = parseModelRef("us.anthropic.claude-opus-4-6-20260115-v1:0", "claude");
    assert.equal(ref?.id, "us.anthropic.claude-opus-4-6-20260115-v1:0");
    assert.equal(ref?.provider, "anthropic");
    // Unattributable to the catalog, so it prices as unknown rather than wrongly.
    assert.equal(lookupRates(ref!), null);
  });

  it("returns null for a missing model", () => {
    assert.equal(parseModelRef(undefined, "claude"), null);
  });
});

describe("lookupRates", () => {
  it("reads the catalog rates in USD per million", () => {
    assert.deepEqual(lookupRates({ provider: "anthropic", id: "claude-haiku-4-5" }), {
      input: 1,
      output: 5,
      cacheRead: 0.1,
      cacheWrite: 1.25,
    });
  });

  it("resolves a dated provider id to its catalog entry", () => {
    // Providers report dated ids the catalog may not carry verbatim.
    const rates = lookupRates({ provider: "anthropic", id: "claude-opus-4-6-20260115" });
    assert.deepEqual(rates, lookupRates({ provider: "anthropic", id: "claude-opus-4-6" }));
  });

  it("prefers the longest matching prefix", () => {
    // `gpt-5` and `gpt-5-mini` are both prefixes of `gpt-5-mini-20260101`; the longer one
    // is the right answer, and the two are priced differently so the test can tell.
    const mini = lookupRates({ provider: "openai", id: "gpt-5-mini-20260101" });
    assert.deepEqual(mini, lookupRates({ provider: "openai", id: "gpt-5-mini" }));
    assert.notDeepEqual(mini, lookupRates({ provider: "openai", id: "gpt-5" }));
  });

  it("does not match across a version separator", () => {
    // `gpt-5` must not stand in for a hypothetical `gpt-5.9`.
    assert.equal(lookupRates({ provider: "openai", id: "gpt-5.9" }), null);
  });

  it("keeps a model whose cacheRead is legitimately zero", () => {
    const rates = lookupRates({ provider: "openai", id: "gpt-4" });
    assert.ok(rates);
    assert.equal(rates.cacheRead, 0);
    assert.ok(rates.input > 0);
  });

  it("returns null for an unknown model or provider", () => {
    assert.equal(lookupRates({ provider: "anthropic", id: "not-a-model" }), null);
    assert.equal(lookupRates({ provider: "not-a-provider", id: "whatever" }), null);
    assert.equal(lookupRates({ id: "claude-haiku-4-5" }), null);
  });
});

describe("costOf", () => {
  it("divides by a million", () => {
    const rates = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
    const cost = costOf(rates, {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheCreation: 1_000_000,
    });
    assert.equal(cost, 1 + 5 + 0.1 + 1.25);
  });

  it("prices a realistic turn", () => {
    const rates = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
    // 2k fresh input, 500 output, 30k cache read, 4k cache write
    const cost = costOf(rates, {
      input: 2_000,
      output: 500,
      cacheRead: 30_000,
      cacheCreation: 4_000,
    });
    assert.equal(cost, (2000 * 1 + 500 * 5 + 30000 * 0.1 + 4000 * 1.25) / 1e6);
  });

  it("treats absent cache counts as zero contribution", () => {
    const rates = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
    assert.equal(costOf(rates, { input: 1_000_000, output: 0 }), 1);
  });
});

describe("priceUsageMetadata", () => {
  const full = {
    input_tokens: 2_000,
    output_tokens: 500,
    cache_read_input_tokens: 30_000,
    cache_creation_input_tokens: 4_000,
    model: "claude-haiku-4-5",
  };

  it("prices a full usage event from its declared model", () => {
    const priced = priceUsageMetadata({ ...full }, { template: "claude" });
    assert.equal(priced.model, "anthropic:claude-haiku-4-5");
    assert.equal(priced.partial, undefined);
    assert.equal(priced.cost_usd, (2000 * 1 + 500 * 5 + 30000 * 0.1 + 4000 * 1.25) / 1e6);
  });

  it("falls back to the mind's configured model when the event names none", () => {
    const { model, ...noModel } = full;
    const priced = priceUsageMetadata(noModel, {
      template: "pi",
      configuredModel: "anthropic:claude-haiku-4-5",
    });
    assert.equal(priced.model, "anthropic:claude-haiku-4-5");
    assert.ok(priced.cost_usd && priced.cost_usd > 0);
  });

  it("falls back to the template default when neither is available", () => {
    const { model, ...noModel } = full;
    const priced = priceUsageMetadata(noModel, { template: "codex" });
    assert.equal(priced.model, "openai:gpt-5.4");
    assert.ok(priced.cost_usd && priced.cost_usd > 0);
  });

  it("records cost_usd null for an unpriced (custom) model", () => {
    const priced = priceUsageMetadata(
      { ...full, model: "anthropic:some-host-added-model" },
      { template: "claude" },
    );
    assert.equal(priced.cost_usd, null);
    assert.equal(priced.model, "anthropic:some-host-added-model");
    assert.equal(priced.partial, undefined);
  });

  it("records cost_usd null when no model can be resolved at all", () => {
    const priced = priceUsageMetadata(
      { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0 },
      {},
    );
    assert.equal(priced.cost_usd, null);
    assert.equal(priced.model, undefined);
  });

  it("prices a per-model breakdown at each model's own rates and sums", () => {
    // The case single-model attribution gets wrong: an Opus turn whose context arrives as
    // cache reads, plus a Haiku side-call that has more raw input+output.
    const priced = priceUsageMetadata(
      {
        input_tokens: 20_300,
        output_tokens: 1_200,
        cache_read_input_tokens: 150_000,
        cache_creation_input_tokens: 0,
        model: "claude-opus-4-6",
        models: [
          {
            model: "claude-opus-4-6",
            input_tokens: 300,
            output_tokens: 900,
            cache_read_input_tokens: 150_000,
            cache_creation_input_tokens: 0,
          },
          {
            model: "claude-haiku-4-5",
            input_tokens: 20_000,
            output_tokens: 300,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        ],
      },
      { template: "claude" },
    );
    const opus = (300 * 5 + 900 * 25 + 150_000 * 0.5) / 1e6;
    const haiku = (20_000 * 1 + 300 * 5) / 1e6;
    assert.equal(priced.cost_usd, opus + haiku);
    // Pricing the aggregate at Haiku's rates — what ranking on input+output alone would
    // have produced — comes to $0.0413 against the true $0.1205, a 2.9x undercount. The
    // breakdown is what prevents it.
    const asHaiku = (20_300 * 1 + 1_200 * 5 + 150_000 * 0.1) / 1e6;
    assert.ok(priced.cost_usd! > asHaiku * 2.5, `${priced.cost_usd} vs ${asHaiku}`);
  });

  it("leaves the whole turn unpriced when one slice has no pricing", () => {
    // A sum missing a model's share is a wrong number, not a cheaper turn.
    const priced = priceUsageMetadata(
      {
        input_tokens: 100,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        model: "claude-opus-4-6",
        models: [
          {
            model: "claude-opus-4-6",
            input_tokens: 50,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          {
            model: "a-model-nobody-has-priced",
            input_tokens: 50,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        ],
      },
      { template: "claude" },
    );
    assert.equal(priced.cost_usd, null);
    assert.equal(priced.partial, undefined);
  });

  it("falls back to the aggregate when there is no breakdown", () => {
    const priced = priceUsageMetadata({ ...full, models: [] }, { template: "claude" });
    assert.equal(priced.cost_usd, (2000 * 1 + 500 * 5 + 30000 * 0.1 + 4000 * 1.25) / 1e6);
  });

  it("flags an un-upgraded mind's two-field event as partial and leaves it unpriced", () => {
    // The old shape: no cache fields at all. Absence is not zero — pricing input+output
    // alone would understate a long-running mind by orders of magnitude.
    const priced = priceUsageMetadata(
      { input_tokens: 913, output_tokens: 112_916 },
      { template: "claude", configuredModel: "claude-haiku-4-5" },
    );
    assert.equal(priced.partial, true);
    assert.equal(priced.cost_usd, null);
    // The model still resolves, so surfaces can name what it would have been priced at.
    assert.equal(priced.model, "anthropic:claude-haiku-4-5");
  });

  it("does not flag partial when only one cache field is present", () => {
    const priced = priceUsageMetadata(
      {
        input_tokens: 10,
        output_tokens: 2,
        cache_read_input_tokens: 500,
        model: "claude-haiku-4-5",
      },
      { template: "claude" },
    );
    assert.equal(priced.partial, undefined);
    assert.equal(priced.cost_usd, (10 * 1 + 2 * 5 + 500 * 0.1) / 1e6);
  });

  it("prices a zero-cache turn at zero cache cost rather than calling it partial", () => {
    const priced = priceUsageMetadata(
      {
        input_tokens: 1_000,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        model: "claude-haiku-4-5",
      },
      { template: "claude" },
    );
    assert.equal(priced.partial, undefined);
    assert.equal(priced.cost_usd, 1000 / 1e6);
  });
});
