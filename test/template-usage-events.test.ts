import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildUsagePayload,
  dominantModel,
  usageByModel,
} from "../templates/claude/src/lib/usage.js";
import { usageDelta, ZERO_USAGE } from "../templates/codex/src/lib/usage.js";

describe("claude template usage", () => {
  it("carries the cache fields the SDK reports alongside input_tokens", () => {
    // The claude SDK reports cache reads/writes beside input_tokens, not folded into it.
    const payload = buildUsagePayload({
      usage: {
        input_tokens: 1_200,
        output_tokens: 340,
        cache_read_input_tokens: 48_000,
        cache_creation_input_tokens: 3_100,
      },
      modelUsage: {
        "claude-opus-4-6-20260115": { inputTokens: 1_200, outputTokens: 340 },
      },
    });
    assert.deepEqual(payload, {
      input_tokens: 1_200,
      output_tokens: 340,
      cache_read_input_tokens: 48_000,
      cache_creation_input_tokens: 3_100,
      model: "claude-opus-4-6-20260115",
      models: [
        {
          model: "claude-opus-4-6-20260115",
          input_tokens: 1_200,
          output_tokens: 340,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      ],
    });
  });

  it("reports a real zero when the SDK says the turn used no cache", () => {
    const payload = buildUsagePayload({
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });
    assert.equal(payload?.cache_read_input_tokens, 0);
    assert.equal(payload?.cache_creation_input_tokens, 0);
  });

  it("leaves the cache fields absent when the SDK reports none", () => {
    // Absence must survive to the daemon, which flags the turn partial rather than
    // pricing it as if nothing had been cached.
    const payload = buildUsagePayload({ usage: { input_tokens: 10, output_tokens: 2 } });
    assert.ok(payload);
    assert.equal("cache_read_input_tokens" in payload, false);
    assert.equal("cache_creation_input_tokens" in payload, false);
  });

  it("emits nothing when the result carries no usage", () => {
    assert.equal(buildUsagePayload({}), undefined);
  });

  it("names the model that did most of the work", () => {
    const model = dominantModel({
      "claude-haiku-4-5": { inputTokens: 900, outputTokens: 40 },
      "claude-opus-4-6": { inputTokens: 40_000, outputTokens: 800 },
    });
    assert.equal(model, "claude-opus-4-6");
  });

  it("ranks the dominant model on cache tokens too", () => {
    // For a long-running mind the main model's context arrives as cache reads. Ranking on
    // input+output alone would hand the label to a small side-call.
    const model = dominantModel({
      "claude-haiku-4-5": { inputTokens: 20_000, outputTokens: 300 },
      "claude-opus-4-6": {
        inputTokens: 300,
        outputTokens: 900,
        cacheReadInputTokens: 150_000,
      },
    });
    assert.equal(model, "claude-opus-4-6");
  });

  it("emits a per-model breakdown so each model is priced at its own rate", () => {
    const slices = usageByModel({
      "claude-opus-4-6": {
        inputTokens: 300,
        outputTokens: 900,
        cacheReadInputTokens: 150_000,
        cacheCreationInputTokens: 2_000,
      },
      "claude-haiku-4-5": { inputTokens: 20_000, outputTokens: 300 },
    });
    assert.deepEqual(slices, [
      {
        model: "claude-opus-4-6",
        input_tokens: 300,
        output_tokens: 900,
        cache_read_input_tokens: 150_000,
        cache_creation_input_tokens: 2_000,
      },
      {
        model: "claude-haiku-4-5",
        input_tokens: 20_000,
        output_tokens: 300,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    ]);
  });

  it("drops models that consumed nothing", () => {
    // A zero slice adds nothing but could fail to resolve, taking the whole turn unpriced.
    const slices = usageByModel({
      "claude-opus-4-6": { inputTokens: 10, outputTokens: 5 },
      "some-unlisted-model": { inputTokens: 0, outputTokens: 0 },
    });
    assert.deepEqual(
      slices?.map((s) => s.model),
      ["claude-opus-4-6"],
    );
  });

  it("reports no breakdown when the SDK gives no per-model usage", () => {
    assert.equal(usageByModel(undefined), undefined);
    assert.equal(usageByModel({}), undefined);
  });

  it("leaves the model undefined when the result reports none", () => {
    assert.equal(dominantModel(undefined), undefined);
    assert.equal(dominantModel({}), undefined);
  });
});

describe("codex template usage", () => {
  it("emits the difference from the last cumulative snapshot", () => {
    // codex's turn.completed carries the thread's running total, not the turn's own usage.
    // Real observed series from a live mind: 538002 → 584162 across two turns.
    const first = usageDelta(ZERO_USAGE, {
      input_tokens: 538_002,
      cached_input_tokens: 500_000,
      cache_write_input_tokens: 0,
      output_tokens: 3_789,
    });
    assert.ok(first);
    assert.equal(first.payload.input_tokens, 38_002);
    assert.equal(first.payload.cache_read_input_tokens, 500_000);
    assert.equal(first.payload.output_tokens, 3_789);

    const second = usageDelta(first.next, {
      input_tokens: 584_162,
      cached_input_tokens: 544_000,
      cache_write_input_tokens: 0,
      output_tokens: 3_982,
    });
    assert.ok(second);
    assert.equal(second.payload.input_tokens, 46_160 - 44_000);
    assert.equal(second.payload.cache_read_input_tokens, 44_000);
    assert.equal(second.payload.output_tokens, 193);
  });

  it("subtracts cached tokens, which codex folds into input_tokens", () => {
    const delta = usageDelta(ZERO_USAGE, {
      input_tokens: 36_484,
      cached_input_tokens: 35_584,
      cache_write_input_tokens: 0,
      output_tokens: 169,
    });
    assert.ok(delta);
    assert.equal(delta.payload.input_tokens, 900);
    assert.equal(delta.payload.cache_read_input_tokens, 35_584);
  });

  it("reports cache writes without subtracting them from input", () => {
    // codex-rs leaves cache-write tokens inside non-cached input (OpenAI bills them at the
    // ordinary input rate), so they are reported for visibility only.
    const delta = usageDelta(ZERO_USAGE, {
      input_tokens: 10_000,
      cached_input_tokens: 4_000,
      cache_write_input_tokens: 2_000,
      output_tokens: 100,
    });
    assert.ok(delta);
    assert.equal(delta.payload.input_tokens, 6_000);
    assert.equal(delta.payload.cache_creation_input_tokens, 2_000);
  });

  it("clamps a single field that wobbles backwards instead of rebasing everything", () => {
    // The blast radius that matters: an all-or-nothing reset on any backwards field would
    // bill this one turn for the entire thread.
    const prev = { input: 500_000, cacheRead: 400_000, cacheCreation: 50, output: 4_000 };
    const delta = usageDelta(prev, {
      input_tokens: 536_000,
      cached_input_tokens: 430_000,
      cache_write_input_tokens: 49, // one token backwards
      output_tokens: 4_100,
    });
    assert.ok(delta);
    assert.equal(delta.payload.input_tokens, 36_000 - 30_000);
    assert.equal(delta.payload.cache_read_input_tokens, 30_000);
    assert.equal(delta.payload.cache_creation_input_tokens, 0);
    assert.equal(delta.payload.output_tokens, 100);
  });

  it("treats a counter that went backwards as a fresh thread", () => {
    const prev = { input: 700_000, cacheRead: 600_000, cacheCreation: 0, output: 5_000 };
    const delta = usageDelta(prev, {
      input_tokens: 36_000,
      cached_input_tokens: 30_000,
      cache_write_input_tokens: 0,
      output_tokens: 120,
    });
    assert.ok(delta);
    assert.equal(delta.payload.input_tokens, 6_000);
    assert.equal(delta.payload.output_tokens, 120);
  });

  it("emits nothing when the cumulative total did not move", () => {
    // Observed in real rollouts: a repeated identical total (…1189605 1189605).
    const prev = { input: 1_189_605, cacheRead: 1_000_000, cacheCreation: 0, output: 900 };
    const delta = usageDelta(prev, {
      input_tokens: 1_189_605,
      cached_input_tokens: 1_000_000,
      cache_write_input_tokens: 0,
      output_tokens: 900,
    });
    assert.equal(delta, null);
  });

  it("accepts the camelCase field spellings too", () => {
    const delta = usageDelta(ZERO_USAGE, {
      inputTokens: 5_000,
      cachedInputTokens: 1_000,
      outputTokens: 50,
    });
    assert.ok(delta);
    assert.equal(delta.payload.input_tokens, 4_000);
    assert.equal(delta.payload.cache_read_input_tokens, 1_000);
  });
});
