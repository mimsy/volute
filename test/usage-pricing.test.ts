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

  it("prices a 1-hour cache write at twice input, not the catalog's 5-minute rate", () => {
    // Anthropic: 5-minute writes cost 1.25x input, 1-hour writes 2x. The catalog quotes
    // only the former, and every main-loop write a claude mind makes is the latter.
    const rates = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
    const cost = costOf(rates, {
      input: 0,
      output: 0,
      cacheCreation: 4_000,
      cacheCreation1h: 3_000,
    });
    assert.equal(cost, (1_000 * 1.25 + 3_000 * 2) / 1e6);
    // A 1h count larger than the writes it is part of can't bill tokens that weren't written.
    assert.equal(
      costOf(rates, { input: 0, output: 0, cacheCreation: 1_000, cacheCreation1h: 5_000 }),
      2_000 / 1e6,
    );
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

  it("prices cache writes by the TTL split the event carries", () => {
    const priced = priceUsageMetadata(
      { ...full, cache_creation_1h_input_tokens: 3_000 },
      { template: "claude" },
    );
    assert.equal(
      priced.cost_usd,
      (2000 * 1 + 500 * 5 + 30000 * 0.1 + 1000 * 1.25 + 3000 * 2) / 1e6,
    );
  });

  it("assumes no TTL when the event reports no split, on any template", () => {
    // The TTL depends on the SDK, the auth mode and the backend. Only a reported split is
    // priced as 1-hour; without one every write stays at the catalog's 5-minute rate.
    const fiveMinute = (2000 * 1 + 500 * 5 + 30000 * 0.1 + 4000 * 1.25) / 1e6;
    for (const template of ["claude", "pi", "codex"]) {
      const priced = priceUsageMetadata(
        { ...full, model: "anthropic:claude-haiku-4-5" },
        { template },
      );
      assert.equal(priced.cost_usd, fiveMinute, template);
    }
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

  it("distrusts a breakdown whose primary slice claims more than the turn used", () => {
    // A mind running a pre-#981 template forwards the SDK's session-cumulative
    // `modelUsage` as this turn's slices. Pricing them bills the whole stream over
    // again, every turn. The turn's own aggregate is the ground truth we still have.
    const priced = priceUsageMetadata(
      {
        input_tokens: 58,
        output_tokens: 1_133,
        cache_read_input_tokens: 274_273,
        cache_creation_input_tokens: 1_998,
        model: "claude-haiku-4-5",
        models: [
          {
            model: "claude-haiku-4-5",
            input_tokens: 620,
            output_tokens: 18_802,
            cache_read_input_tokens: 1_542_289,
            cache_creation_input_tokens: 138_603,
          },
        ],
      },
      { template: "claude" },
    );
    const fromAggregate = (58 * 1 + 1_133 * 5 + 274_273 * 0.1 + 1_998 * 1.25) / 1e6;
    assert.equal(priced.cost_usd, fromAggregate);
  });

  it("keeps a breakdown whose side-call sits outside the turn aggregate", () => {
    // The guard above must not fire here. On a genuine multi-model turn the top-level
    // `usage` covers the primary model only, so the side-call's tokens legitimately push
    // the slice *sum* past the aggregate — while the primary slice still matches it.
    const priced = priceUsageMetadata(
      {
        input_tokens: 104,
        output_tokens: 24_250,
        cache_read_input_tokens: 300_000,
        cache_creation_input_tokens: 0,
        model: "claude-opus-4-6",
        models: [
          {
            model: "claude-opus-4-6",
            input_tokens: 104,
            output_tokens: 24_250,
            cache_read_input_tokens: 300_000,
            cache_creation_input_tokens: 0,
          },
          {
            model: "claude-haiku-4-5",
            input_tokens: 79_675,
            output_tokens: 2_839,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        ],
      },
      { template: "claude" },
    );
    const opus = (104 * 5 + 24_250 * 25 + 300_000 * 0.5) / 1e6;
    const haiku = (79_675 * 1 + 2_839 * 5) / 1e6;
    assert.equal(priced.cost_usd, opus + haiku);
  });

  describe("a turn with a Task subagent (#984)", () => {
    // Recorded from a real SDK run: haiku main loop, an `inherit` subagent on turn 2. The
    // subagent's tokens sit under the main loop's key in `modelUsage` and are missing from
    // `usage`, so the main slice legitimately exceeds the aggregate. Its 5420 cache-write
    // tokens are 5-minute; the main loop's 1074 are 1-hour. The SDK's own `costUSD` for
    // this turn differenced to $0.0169418.
    const turn2 = {
      input_tokens: 18,
      output_tokens: 582,
      cache_read_input_tokens: 43_408,
      cache_creation_input_tokens: 1_074,
      cache_creation_1h_input_tokens: 1_074,
      model: "claude-haiku-4-5",
      models: [
        {
          model: "claude-haiku-4-5",
          input_tokens: 28,
          output_tokens: 730,
          cache_read_input_tokens: 43_408,
          cache_creation_input_tokens: 6_494,
        },
      ],
    };
    const sdkCost = (28 * 1 + 730 * 5 + 43_408 * 0.1 + 1_074 * 2 + 5_420 * 1.25) / 1e6;
    const close = (a: number | null, b: number) =>
      assert.ok(a !== null && Math.abs(a - b) < 1e-12, `${a} vs ${b}`);

    it("prices the subagent from a breakdown marked with main_model", () => {
      const priced = priceUsageMetadata(
        { ...turn2, main_model: "claude-haiku-4-5" },
        { template: "claude" },
      );
      close(priced.cost_usd, sdkCost);
    });

    it("still prices an unmarked breakdown on its aggregate, dropping the subagent", () => {
      // Minds on a template older than main_model. Pinned so the undercount stays a known,
      // documented one until they upgrade — not something inferred around.
      const priced = priceUsageMetadata({ ...turn2 }, { template: "claude" });
      close(priced.cost_usd, (18 * 1 + 582 * 5 + 43_408 * 0.1 + 1_074 * 2) / 1e6);
    });

    it("puts the 1h writes on the main loop's slice even when a subagent's model dominates", () => {
      // `model` is the dominant label. A big sonnet subagent takes it from an opus main
      // loop; the 1h writes must still be priced at opus's rates, on opus's slice.
      const priced = priceUsageMetadata(
        {
          input_tokens: 10,
          output_tokens: 100,
          cache_read_input_tokens: 50_000,
          cache_creation_input_tokens: 2_000,
          cache_creation_1h_input_tokens: 2_000,
          model: "claude-sonnet-5",
          main_model: "claude-opus-4-6",
          models: [
            {
              model: "claude-opus-4-6",
              input_tokens: 10,
              output_tokens: 100,
              cache_read_input_tokens: 50_000,
              cache_creation_input_tokens: 2_000,
            },
            {
              model: "claude-sonnet-5",
              input_tokens: 40,
              output_tokens: 3_000,
              cache_read_input_tokens: 400_000,
              cache_creation_input_tokens: 30_000,
            },
          ],
        },
        { template: "claude" },
      );
      const opus = (10 * 5 + 100 * 25 + 50_000 * 0.5 + 2_000 * 10) / 1e6;
      const sonnet = (40 * 2 + 3_000 * 10 + 400_000 * 0.2 + 30_000 * 2.5) / 1e6;
      close(priced.cost_usd, opus + sonnet);
    });

    it("matches a main_model to the one slice that is its dated form", () => {
      const priced = priceUsageMetadata(
        {
          ...turn2,
          main_model: "claude-haiku-4-5",
          models: [{ ...turn2.models[0], model: "claude-haiku-4-5-20251001" }],
        },
        { template: "claude" },
      );
      close(priced.cost_usd, sdkCost);
    });

    it("prices the main loop's aggregate at its own rates when main_model matches no slice", () => {
      // No slice to hang the 1h writes on, and no way to tell the subagent apart: price
      // what can be priced honestly — the aggregate, 1h split included, at the main
      // loop's rates rather than the dominant label's.
      const aggregate = (18 * 5 + 582 * 25 + 43_408 * 0.5 + 1_074 * 10) / 1e6;
      const unmatched = priceUsageMetadata(
        {
          ...turn2,
          model: "claude-haiku-4-5",
          main_model: "claude-opus-4-6",
          models: [{ ...turn2.models[0], model: "claude-haiku-4-5" }],
        },
        { template: "claude" },
      );
      close(unmatched.cost_usd, aggregate);
      // Two slices that could each be it is the same answer, not a guess.
      const ambiguous = priceUsageMetadata(
        {
          ...turn2,
          main_model: "claude-opus-4-6",
          models: [
            { ...turn2.models[0], model: "claude-opus-4-6-20260115" },
            { ...turn2.models[0], model: "claude-opus-4-6-20260301" },
          ],
        },
        { template: "claude" },
      );
      close(ambiguous.cost_usd, aggregate);
    });
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

describe("a bare model id borrows a provider instead of blocking the fallback", () => {
  it("prices a bare declared id using the configured model's provider", () => {
    // parseModelRef returns a non-null ref with no provider for a bare id, which a
    // plain `??` chain treats as resolved — so the candidates that would have
    // supplied a provider were never consulted and the turn priced to null.
    const priced = priceUsageMetadata(
      {
        input_tokens: 1_000,
        output_tokens: 1_000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        model: "claude-haiku-4-5", // bare — no provider, no template to infer one
      },
      { mind: "m", configuredModel: "anthropic:claude-sonnet-4-5" },
    );
    assert.equal(priced.cost_usd, (1000 * 1 + 1000 * 5) / 1e6);
  });

  it("keeps the model that actually ran rather than the configured one", () => {
    // The declared id is ground truth for the turn. Falling through to the configured
    // model would price a model that never ran and mislabel the row.
    const priced = priceUsageMetadata(
      {
        input_tokens: 1_000,
        output_tokens: 1_000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        model: "claude-haiku-4-5",
      },
      { mind: "m", configuredModel: "anthropic:claude-sonnet-4-5" },
    );
    assert.equal(priced.model, "anthropic:claude-haiku-4-5", "haiku's id, anthropic's provider");
  });

  it("still records no cost when nothing can supply a provider", () => {
    const priced = priceUsageMetadata(
      {
        input_tokens: 10,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        model: "some-unknown-model",
      },
      { mind: "m" },
    );
    assert.equal(priced.cost_usd, null);
    assert.equal(priced.model, "some-unknown-model", "still labelled, just unpriced");
  });
});
