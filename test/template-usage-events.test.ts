import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { priceUsageMetadata } from "../packages/daemon/src/lib/daemon/usage-pricing.js";
import { composeTemplate } from "../packages/daemon/src/lib/template/template.js";
import type { UsageByModel } from "../templates/_base/src/lib/types.js";
import {
  advanceBaseline,
  buildUsagePayload,
  dominantModel,
  restoredTotals,
  usageByModel,
} from "../templates/claude/src/lib/usage.js";
import { usageDelta, ZERO_USAGE } from "../templates/codex/src/lib/usage.js";

/** A per-model slice with the zero fields filled in, so tests name only what matters. */
function slice(model: string, fields: Partial<UsageByModel>): UsageByModel {
  return {
    model,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    ...fields,
  };
}

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
    const model = dominantModel([
      slice("claude-haiku-4-5", { input_tokens: 900, output_tokens: 40 }),
      slice("claude-opus-4-6", { input_tokens: 40_000, output_tokens: 800 }),
    ]);
    assert.equal(model, "claude-opus-4-6");
  });

  it("ranks the dominant model on cache tokens too", () => {
    // For a long-running mind the main model's context arrives as cache reads. Ranking on
    // input+output alone would hand the label to a small side-call.
    const model = dominantModel([
      slice("claude-haiku-4-5", { input_tokens: 20_000, output_tokens: 300 }),
      slice("claude-opus-4-6", {
        input_tokens: 300,
        output_tokens: 900,
        cache_read_input_tokens: 150_000,
      }),
    ]);
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

  it("emits this turn's share of the session-cumulative per-model counter", () => {
    // `result.modelUsage` accumulates across every turn in the stream while `result.usage`
    // is the turn's own delta. Real observed pair from a live fable-5 mind (#981): the
    // second turn's cumulative is the first's plus its own usage, on all four fields.
    const first = buildUsagePayload({
      usage: {
        input_tokens: 562,
        output_tokens: 17_669,
        cache_read_input_tokens: 1_268_016,
        cache_creation_input_tokens: 136_605,
      },
      modelUsage: {
        "claude-fable-5": {
          inputTokens: 562,
          outputTokens: 17_669,
          cacheReadInputTokens: 1_268_016,
          cacheCreationInputTokens: 136_605,
        },
      },
    });
    assert.deepEqual(first?.models?.[0], {
      model: "claude-fable-5",
      input_tokens: 562,
      output_tokens: 17_669,
      cache_read_input_tokens: 1_268_016,
      cache_creation_input_tokens: 136_605,
    });

    const cumulative = {
      "claude-fable-5": {
        inputTokens: 620,
        outputTokens: 18_802,
        cacheReadInputTokens: 1_542_289,
        cacheCreationInputTokens: 138_603,
      },
    };
    const second = buildUsagePayload(
      {
        usage: {
          input_tokens: 58,
          output_tokens: 1_133,
          cache_read_input_tokens: 274_273,
          cache_creation_input_tokens: 1_998,
        },
        modelUsage: cumulative,
      },
      {
        "claude-fable-5": {
          inputTokens: 562,
          outputTokens: 17_669,
          cacheReadInputTokens: 1_268_016,
          cacheCreationInputTokens: 136_605,
        },
      },
    );
    // The slice must describe this turn, not the stream. Billed cumulatively this turn
    // cost $4.22 against a true $0.36.
    assert.deepEqual(second?.models?.[0], {
      model: "claude-fable-5",
      input_tokens: 58,
      output_tokens: 1_133,
      cache_read_input_tokens: 274_273,
      cache_creation_input_tokens: 1_998,
    });
  });

  it("treats a counter that went backwards as a fresh stream", () => {
    const slices = usageByModel(
      { "claude-opus-4-6": { inputTokens: 40, outputTokens: 120, cacheReadInputTokens: 900 } },
      { "claude-opus-4-6": { inputTokens: 9_000, outputTokens: 30_000 } },
    );
    assert.deepEqual(slices?.[0], {
      model: "claude-opus-4-6",
      input_tokens: 40,
      output_tokens: 120,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 0,
    });
  });

  it("treats a drop in any counter as a reset, even when output has grown past the old", () => {
    // A /clear mid-stream: the new accumulator's output already exceeds the old one's, but
    // its cache reads don't. Testing output alone kept the stale baseline and undercounted.
    const slices = usageByModel(
      { "claude-opus-4-6": { inputTokens: 40, outputTokens: 400, cacheReadInputTokens: 900 } },
      { "claude-opus-4-6": { inputTokens: 30, outputTokens: 300, cacheReadInputTokens: 50_000 } },
    );
    assert.deepEqual(slices?.[0], {
      model: "claude-opus-4-6",
      input_tokens: 40,
      output_tokens: 400,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 0,
    });
  });

  it("carries the baseline forward per model", () => {
    const main = { inputTokens: 10, outputTokens: 200, cacheReadInputTokens: 5_000 };
    const side = { inputTokens: 899, outputTokens: 9 };
    // A result that lists only a side-call must not wipe the main loop's baseline — the
    // next turn would bill the whole stream (#981).
    assert.deepEqual(advanceBaseline({ "claude-opus-4-6": main }, { "claude-haiku-4-5": side }), {
      "claude-opus-4-6": main,
      "claude-haiku-4-5": side,
    });
    // Nor a zeroed crash result, entries or none.
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };
    assert.deepEqual(advanceBaseline({ "claude-opus-4-6": main }, { "claude-opus-4-6": zero }), {
      "claude-opus-4-6": main,
    });
    assert.deepEqual(advanceBaseline({ "claude-opus-4-6": main }, {}), { "claude-opus-4-6": main });
  });

  it("drops a model that consumed nothing on this turn", () => {
    // Its cumulative is non-zero, so only the delta reveals that it sat this turn out.
    const slices = usageByModel(
      {
        "claude-opus-4-6": { inputTokens: 50, outputTokens: 900 },
        "claude-haiku-4-5": { inputTokens: 20_000, outputTokens: 300 },
      },
      {
        "claude-opus-4-6": { inputTokens: 10, outputTokens: 400 },
        "claude-haiku-4-5": { inputTokens: 20_000, outputTokens: 300 },
      },
    );
    assert.deepEqual(
      slices?.map((s) => s.model),
      ["claude-opus-4-6"],
    );
  });

  it("names the model that did most of *this turn's* work", () => {
    // Ranked on the cumulative, a mind whose stream is mostly Opus would label every
    // Haiku-only side turn "opus" for the rest of the stream.
    const payload = buildUsagePayload(
      {
        usage: {
          input_tokens: 20_000,
          output_tokens: 300,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        modelUsage: {
          "claude-opus-4-6": { inputTokens: 300, outputTokens: 900, cacheReadInputTokens: 800_000 },
          "claude-haiku-4-5": { inputTokens: 20_100, outputTokens: 320 },
        },
      },
      {
        "claude-opus-4-6": { inputTokens: 300, outputTokens: 900, cacheReadInputTokens: 800_000 },
        "claude-haiku-4-5": { inputTokens: 100, outputTokens: 20 },
      },
    );
    assert.equal(payload?.model, "claude-haiku-4-5");
  });

  it("reports no breakdown when the SDK gives no per-model usage", () => {
    assert.equal(usageByModel(undefined), undefined);
    assert.equal(usageByModel({}), undefined);
  });

  it("leaves the model undefined when the result reports none", () => {
    assert.equal(dominantModel(undefined), undefined);
    assert.equal(dominantModel([]), undefined);
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

/**
 * `UsageDelta.contextTokens` — the turn's own context size, which the dashboard falls
 * back to when the rollout carries no usage event yet.
 *
 * It gated rotation in the first half of #913's fix, and a session-cumulative counter
 * there rotated the session every turn for the rest of its life. Rotation now measures
 * the rollout (see test/codex-rotation.test.ts); these cases pin the arithmetic that
 * kept the displayed figure from being the thread's lifetime total.
 *
 * The threshold compared against is the one the codex template ships
 * (`home/.config/config.json`), so the numbers stay recognisable.
 */
describe("codex template: the turn's own context size", () => {
  const MAX_CONTEXT_TOKENS = 150_000;

  /** One turn's cumulative snapshot, shaped like codex's `total_token_usage`. */
  function snapshot(input: number, cached: number, output: number) {
    // codex folds cached reads into input_tokens; the context is the whole of it.
    return {
      input_tokens: input,
      cached_input_tokens: cached,
      cache_write_input_tokens: 0,
      output_tokens: output,
    };
  }

  it("stays under the threshold across turns whose running total is far over it", () => {
    // The real series from a live mind, five consecutive turns of a long session. Each
    // turn sends ~46k of context, most of it a cache hit on the turn before; the thread's
    // lifetime total is already 3.5x the window and still climbing.
    const cumulative = [538_002, 584_162, 630_756, 677_701, 724_993];
    let prev = { input: cumulative[0], cacheRead: 484_202, cacheCreation: 0, output: 3_789 };

    for (const [i, total] of cumulative.slice(1).entries()) {
      const delta = usageDelta(
        prev,
        snapshot(total, Math.round(total * 0.9), 3_789 + (i + 1) * 200),
      );
      assert.ok(delta);
      assert.ok(
        delta.contextTokens < MAX_CONTEXT_TOKENS,
        `turn ${i + 1}: ${delta.contextTokens} tokens of context should not rotate`,
      );
      // The field the gate used to read, on the same turn: rotation every time.
      assert.ok(delta.next.input >= MAX_CONTEXT_TOKENS);
      prev = delta.next;
    }
  });

  it("crosses the threshold when a single turn's own context does", () => {
    const prev = { input: 538_002, cacheRead: 484_202, cacheCreation: 0, output: 3_789 };
    const total = 538_002 + 151_400;
    const delta = usageDelta(prev, snapshot(total, Math.round(total * 0.9), 4_100));
    assert.ok(delta);
    // The exact figure, not just "over": the cumulative counter would say 689_402 here,
    // so this pins that rotation fires on the turn's own size rather than the thread's.
    assert.equal(delta.contextTokens, 151_400);
    assert.ok(delta.contextTokens >= MAX_CONTEXT_TOKENS);
  });

  it("counts the cached portion, which is context the model still read", () => {
    // Almost all of a long turn's input is a cache read. Narrowing it away for billing
    // would report a near-empty context window on a nearly-full one.
    const prev = { input: 100_000, cacheRead: 90_000, cacheCreation: 0, output: 500 };
    const delta = usageDelta(prev, snapshot(240_000, 216_000, 700));
    assert.ok(delta);
    assert.equal(delta.contextTokens, 140_000);
    // What the same turn bills, with the 126k cache read taken out at its own rate.
    assert.equal(delta.payload.input_tokens, 14_000);
  });

  it("reports a fresh thread's own context after a counter reset", () => {
    // Rotation and restart both restart the counter; the new total is the new context.
    // Cumulative and per-turn coincide here, so this pins the reset branch rather than
    // discriminating the fix — a naive `next.input - prev.input` would report 0.
    const prev = { input: 700_000, cacheRead: 600_000, cacheCreation: 0, output: 5_000 };
    const delta = usageDelta(prev, snapshot(46_000, 41_400, 120));
    assert.ok(delta);
    assert.equal(delta.contextTokens, 46_000);
  });
});

/**
 * The wiring, not the arithmetic: `usageByModel` can difference correctly and the mind
 * still be billed cumulatively if the caller never carries the baseline forward. Drives
 * the real composed template — as `volute mind create` ships it — across two turns of one
 * stream, which is the shortest run in which the bug is visible at all.
 */
describe("claude template: consecutive turns in one stream", () => {
  let consumeStream: typeof import("../templates/claude/src/lib/stream-consumer.js")["consumeStream"];
  let composedDir: string;

  before(async () => {
    composedDir = composeTemplate(
      resolvePath(fileURLToPath(import.meta.url), "../../templates"),
      "claude",
    ).composedDir;
    ({ consumeStream } = await import(resolvePath(composedDir, "src/lib/stream-consumer.js")));
  });

  after(() => rmSync(composedDir, { recursive: true, force: true }));

  it("bills the second turn its own share, not the stream's running total", async () => {
    // The pair that exposed #981 on a live mind, cumulative counter and all.
    const turns = [
      {
        usage: {
          input_tokens: 562,
          output_tokens: 17_669,
          cache_read_input_tokens: 1_268_016,
          cache_creation_input_tokens: 136_605,
        },
        modelUsage: {
          "claude-fable-5": {
            inputTokens: 562,
            outputTokens: 17_669,
            cacheReadInputTokens: 1_268_016,
            cacheCreationInputTokens: 136_605,
          },
        },
      },
      {
        usage: {
          input_tokens: 58,
          output_tokens: 1_133,
          cache_read_input_tokens: 274_273,
          cache_creation_input_tokens: 1_998,
        },
        modelUsage: {
          "claude-fable-5": {
            inputTokens: 620,
            outputTokens: 18_802,
            cacheReadInputTokens: 1_542_289,
            cacheCreationInputTokens: 138_603,
          },
        },
      },
    ];

    const emitted: UsageByModel[][] = [];
    async function* stream() {
      for (const turn of turns) yield { type: "result", subtype: "success", ...turn };
    }

    await consumeStream(
      stream() as never,
      {
        name: "main",
        messageIds: [],
        currentMessageId: undefined,
        currentSeq: undefined,
        messageChannels: new Map(),
      },
      {
        broadcast: (event: { type: string; models?: UsageByModel[] }) => {
          if (event.type === "usage" && event.models) emitted.push(event.models);
        },
        ack: () => {},
      } as never,
    );

    assert.equal(emitted.length, 2);
    assert.deepEqual(emitted[1], [
      {
        model: "claude-fable-5",
        input_tokens: 58,
        output_tokens: 1_133,
        cache_read_input_tokens: 274_273,
        cache_creation_input_tokens: 1_998,
      },
    ]);
  });

  it("carries a Task subagent's share, the main model, and the 1h split; a zeroed result keeps the baseline", async () => {
    // Recorded from a real SDK run (0.3.270): haiku main loop, an `inherit` subagent on
    // turn 2. The subagent's tokens land under the main loop's key in `modelUsage` and are
    // absent from `usage` (#984); its 5420 cache-write tokens are 5-minute, the main
    // loop's 1074 are 1-hour. The dated key is an internal side-call from turn 1.
    const sideCall = {
      inputTokens: 899,
      outputTokens: 9,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    const messages = [
      { type: "system", subtype: "init", model: "claude-haiku-4-5" },
      {
        type: "result",
        subtype: "success",
        usage: {
          input_tokens: 10,
          output_tokens: 197,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 21_569,
          cache_creation: { ephemeral_1h_input_tokens: 21_569, ephemeral_5m_input_tokens: 0 },
        },
        modelUsage: {
          "claude-haiku-4-5-20251001": sideCall,
          "claude-haiku-4-5": {
            inputTokens: 10,
            outputTokens: 197,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 21_569,
          },
        },
      },
      { type: "system", subtype: "init", model: "claude-haiku-4-5" },
      {
        type: "result",
        subtype: "success",
        usage: {
          input_tokens: 18,
          output_tokens: 582,
          cache_read_input_tokens: 43_408,
          cache_creation_input_tokens: 1_074,
          cache_creation: { ephemeral_1h_input_tokens: 1_074, ephemeral_5m_input_tokens: 0 },
        },
        modelUsage: {
          "claude-haiku-4-5-20251001": sideCall,
          "claude-haiku-4-5": {
            inputTokens: 38,
            outputTokens: 927,
            cacheReadInputTokens: 43_408,
            cacheCreationInputTokens: 28_063,
          },
        },
      },
      // A crash result with zeroed counters. Adopted as the baseline, it would bill the
      // next turn for the whole stream.
      {
        type: "result",
        subtype: "error_during_execution",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        modelUsage: {},
      },
      {
        type: "result",
        subtype: "success",
        usage: {
          input_tokens: 10,
          output_tokens: 73,
          cache_read_input_tokens: 16_592,
          cache_creation_input_tokens: 437,
          cache_creation: { ephemeral_1h_input_tokens: 437, ephemeral_5m_input_tokens: 0 },
        },
        modelUsage: {
          "claude-haiku-4-5-20251001": sideCall,
          "claude-haiku-4-5": {
            inputTokens: 48,
            outputTokens: 1_000,
            cacheReadInputTokens: 60_000,
            cacheCreationInputTokens: 28_500,
          },
        },
      },
    ];
    const emitted: Record<string, unknown>[] = [];
    async function* stream() {
      yield* messages;
    }
    await consumeStream(
      stream() as never,
      {
        name: "main",
        messageIds: [],
        currentMessageId: undefined,
        currentSeq: undefined,
        messageChannels: new Map(),
      },
      {
        broadcast: (event: { type: string }) => {
          if (event.type === "usage") emitted.push(event);
        },
        ack: () => {},
      } as never,
    );

    const { type: _, ...turn2 } = emitted[1] as { type: string };
    assert.deepEqual(turn2, {
      input_tokens: 18,
      output_tokens: 582,
      cache_read_input_tokens: 43_408,
      cache_creation_input_tokens: 1_074,
      cache_creation_1h_input_tokens: 1_074,
      main_model: "claude-haiku-4-5",
      model: "claude-haiku-4-5",
      models: [
        slice("claude-haiku-4-5", {
          input_tokens: 28,
          output_tokens: 730,
          cache_read_input_tokens: 43_408,
          cache_creation_input_tokens: 6_494,
        }),
      ],
    });
    // The turn after the crash is differenced against turn 2, not against zero.
    assert.deepEqual((emitted.at(-1) as { models: UsageByModel[] }).models, [
      slice("claude-haiku-4-5", {
        input_tokens: 10,
        output_tokens: 73,
        cache_read_input_tokens: 16_592,
        cache_creation_input_tokens: 437,
      }),
    ]);
  });
});

/**
 * Since SDK 0.3.277 a resumed session's `modelUsage` continues from the earlier session's
 * totals. The numbers below were recorded live on 0.3.281: a haiku turn, then a resume of
 * the same session. The resumed turn's own `usage` wrote 125 cache tokens, while its
 * `modelUsage` reported 15006 — the first turn's 14881 carried over.
 */
describe("claude template: a resumed stream", () => {
  let consumeStream: typeof import("../templates/claude/src/lib/stream-consumer.js")["consumeStream"];
  let composedDir: string;

  before(async () => {
    composedDir = composeTemplate(
      resolvePath(fileURLToPath(import.meta.url), "../../templates"),
      "claude",
    ).composedDir;
    ({ consumeStream } = await import(resolvePath(composedDir, "src/lib/stream-consumer.js")));
  });

  after(() => rmSync(composedDir, { recursive: true, force: true }));

  async function run(
    messages: unknown[],
    resumed: boolean,
    restoredTotals?: Record<string, Record<string, number>>,
  ) {
    const emitted: Record<string, unknown>[] = [];
    async function* stream() {
      yield* messages;
    }
    await consumeStream(
      stream() as never,
      {
        name: "main",
        messageIds: [],
        currentMessageId: undefined,
        currentSeq: undefined,
        messageChannels: new Map(),
      },
      {
        broadcast: (event: { type: string }) => {
          if (event.type === "usage") emitted.push(event);
        },
        ack: () => {},
      } as never,
      { resumed, restoredTotals },
    );
    return emitted;
  }

  const init = { type: "system", subtype: "init", model: "claude-haiku-4-5-20251001" };
  const resumedTurn = {
    type: "result",
    subtype: "success",
    usage: {
      input_tokens: 10,
      output_tokens: 83,
      cache_read_input_tokens: 14_881,
      cache_creation_input_tokens: 125,
    },
    modelUsage: {
      "claude-haiku-4-5-20251001": {
        inputTokens: 918,
        outputTokens: 173,
        cacheReadInputTokens: 14_881,
        cacheCreationInputTokens: 15_006,
      },
    },
  };
  const nextTurn = {
    type: "result",
    subtype: "success",
    usage: {
      input_tokens: 12,
      output_tokens: 40,
      cache_read_input_tokens: 15_006,
      cache_creation_input_tokens: 60,
    },
    modelUsage: {
      "claude-haiku-4-5-20251001": {
        inputTokens: 930,
        outputTokens: 213,
        cacheReadInputTokens: 29_887,
        cacheCreationInputTokens: 15_066,
      },
    },
  };

  it("prices the first turn on its own usage, not the restored session totals", async () => {
    const emitted = await run([init, resumedTurn, nextTurn], true);
    const { type: _, ...first } = emitted[0] as { type: string };
    assert.deepEqual(first, {
      input_tokens: 10,
      output_tokens: 83,
      cache_read_input_tokens: 14_881,
      cache_creation_input_tokens: 125,
      model: "claude-haiku-4-5-20251001",
      main_model: "claude-haiku-4-5-20251001",
      models: undefined,
    });
    // ...and differences the next turn against the restored totals.
    assert.deepEqual((emitted[1] as { models: UsageByModel[] }).models, [
      slice("claude-haiku-4-5-20251001", {
        input_tokens: 12,
        output_tokens: 40,
        cache_read_input_tokens: 15_006,
        cache_creation_input_tokens: 60,
      }),
    ]);
  });

  it("the daemon prices that turn on the main loop's own usage", async () => {
    const emitted = await run([init, resumedTurn], true);
    const { type: _, ...metadata } = emitted[0] as { type: string };
    const priced = priceUsageMetadata(metadata, { template: "claude" });
    assert.equal(priced.partial, undefined);
    assert.ok(priced.cost_usd !== null && priced.cost_usd > 0);
    // Priced on the restored totals instead, the 14881 carried cache writes would dominate.
    const restored = priceUsageMetadata(
      { ...metadata, cache_creation_input_tokens: 15_006 },
      { template: "claude" },
    );
    assert.ok(priced.cost_usd < (restored.cost_usd ?? 0) / 5);
  });

  it("keeps the breakdown when the resumed accumulator started at zero (SDK before 0.3.277)", async () => {
    const fromZero = {
      ...resumedTurn,
      modelUsage: {
        "claude-haiku-4-5-20251001": {
          inputTokens: 10,
          outputTokens: 83,
          cacheReadInputTokens: 14_881,
          cacheCreationInputTokens: 125,
        },
      },
    };
    const emitted = await run([init, fromZero], true);
    assert.equal((emitted[0] as { main_model?: string }).main_model, "claude-haiku-4-5-20251001");
    assert.deepEqual((emitted[0] as { models: UsageByModel[] }).models, [
      slice("claude-haiku-4-5-20251001", {
        input_tokens: 10,
        output_tokens: 83,
        cache_read_input_tokens: 14_881,
        cache_creation_input_tokens: 125,
      }),
    ]);
  });

  it("treats a rotated session the same way — its seeded tail restores part of the totals", async () => {
    // Recorded live on 0.3.281: `rotateSession` with a small seedTokens budget, then a resume
    // of the rotated id. The tail's copied lines bring their usage along, so the first turn
    // reports more than it spent (7092 cache writes against its own 3550).
    const rotatedTurn = {
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 10,
        output_tokens: 86,
        cache_read_input_tokens: 11_470,
        cache_creation_input_tokens: 3_550,
      },
      modelUsage: {
        "claude-haiku-4-5-20251001": {
          inputTokens: 928,
          outputTokens: 277,
          cacheReadInputTokens: 37_822,
          cacheCreationInputTokens: 7_092,
        },
      },
    };
    const emitted = await run([init, rotatedTurn], true);
    const { type: _, ...first } = emitted[0] as { type: string };
    assert.deepEqual(first, {
      input_tokens: 10,
      output_tokens: 86,
      cache_read_input_tokens: 11_470,
      cache_creation_input_tokens: 3_550,
      model: "claude-haiku-4-5-20251001",
      main_model: "claude-haiku-4-5-20251001",
      models: undefined,
    });
  });

  it("drops the breakdown after a model switch — the old model's key holds the earlier session", async () => {
    // Opus earlier in the session, sonnet now. The sonnet slice fits its `usage` exactly,
    // so a main-slice check alone would pass the breakdown and bill opus's whole history.
    const switched = [
      { type: "system", subtype: "init", model: "claude-sonnet-4-6" },
      {
        type: "result",
        subtype: "success",
        usage: {
          input_tokens: 12,
          output_tokens: 300,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 40_000,
        },
        modelUsage: {
          "claude-opus-4-6": {
            inputTokens: 5_000,
            outputTokens: 60_000,
            cacheReadInputTokens: 2_000_000,
            cacheCreationInputTokens: 150_000,
          },
          "claude-sonnet-4-6": {
            inputTokens: 12,
            outputTokens: 300,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 40_000,
          },
        },
      },
    ];
    const emitted = await run(switched, true);
    const { type: _, ...first } = emitted[0] as { type: string };
    assert.deepEqual(first, {
      input_tokens: 12,
      output_tokens: 300,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 40_000,
      model: "claude-sonnet-4-6",
      main_model: "claude-sonnet-4-6",
      models: undefined,
    });
  });

  it("checks the first result that has counters, not a zeroed crash result before it", async () => {
    const crash = {
      type: "result",
      subtype: "error_during_execution",
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
    };
    const emitted = await run([init, crash, resumedTurn], true);
    assert.equal((emitted.at(-1) as { models?: unknown }).models, undefined);
    assert.equal(
      (emitted.at(-1) as { cache_creation_input_tokens: number }).cache_creation_input_tokens,
      125,
    );
  });

  it("is told which streams are resumed", () => {
    // The check only runs when the caller says the stream resumed; if nothing passes the
    // flag, every test above is green while no mind ever runs the check.
    const agent = readFileSync(resolvePath(composedDir, "src/agent.ts"), "utf-8");
    const runStream = agent.slice(agent.indexOf("async function runStream("));
    // In order: wait out a reaped stream's exit, read the totals, bail if torn down
    // meanwhile, and only then spawn the SDK child and pass the totals on.
    assert.match(
      runStream,
      /awaitPriorExit\(exiting\.get\(session\.name\), PRIOR_EXIT_WAIT_MS\);\s*restoredTotals = await readRestoredTotals\(options\.cwd, resume\);[\s\S]*?if \(session\.closed\) return;[\s\S]*?createStream\([\s\S]*?consumeStream\(q, session, callbacks, \{\s*resumed: resume !== undefined,\s*restoredTotals,\s*\}\)/,
    );
    // ...and the reaper publishes its pending exit for that wait to find.
    const reap = agent.slice(agent.indexOf("async function reapSession("));
    assert.match(reap, /exiting\.set\(session\.name, exit\);\s*await exit;/);
  });

  it("leaves a fresh stream's first turn alone", async () => {
    // A fresh stream's accumulator starts at zero, so a main slice larger than `usage` is a
    // subagent or side-call at work (#984), not restored totals.
    const emitted = await run([init, resumedTurn], false);
    assert.ok((emitted[0] as { models?: unknown }).models);
  });

  /**
   * #1155: the SDK restores *every* model's totals on resume, from the last `cost-state` line
   * the transcript holds for the session. Recorded live on 0.3.281 (haiku main, a sonnet
   * subagent): session A ran a plain turn and a subagent turn, its stream ended and wrote
   * this cost-state; session B ran one plain turn, then was resumed into a subagent turn.
   */
  describe("claude template: a resumed stream's first turn, baselined on the restored totals", () => {
    const init = { type: "system", subtype: "init", model: "claude-haiku-4-5" };
    const mu = (i: number, o: number, cr: number, cw: number) => ({
      inputTokens: i,
      outputTokens: o,
      cacheReadInputTokens: cr,
      cacheCreationInputTokens: cw,
    });

    it("counts a subagent on a model the earlier session never used", async () => {
      // Session B: its plain turn saved haiku alone; the resumed turn ran the sonnet subagent.
      const restored = { "claude-haiku-4-5": mu(10, 44, 14_474, 0) };
      const resumedTurn = {
        type: "result",
        subtype: "success",
        usage: {
          input_tokens: 18,
          output_tokens: 806,
          cache_read_input_tokens: 29_060,
          cache_creation_input_tokens: 664,
        },
        modelUsage: {
          "claude-haiku-4-5": mu(28, 850, 43_534, 664),
          "claude-sonnet-5": mu(706, 4, 0, 0),
        },
      };
      const emitted = await run([init, resumedTurn], true, restored);
      assert.deepEqual((emitted[0] as { models: UsageByModel[] }).models, [
        slice("claude-haiku-4-5", {
          input_tokens: 18,
          output_tokens: 806,
          cache_read_input_tokens: 29_060,
          cache_creation_input_tokens: 664,
        }),
        slice("claude-sonnet-5", { input_tokens: 706, output_tokens: 4 }),
      ]);
      // Priced: the subagent's share reaches spend.
      const { type: _, ...metadata } = emitted[0] as { type: string };
      const priced = priceUsageMetadata(metadata, { template: "claude" });
      const mainOnly = priceUsageMetadata(
        { ...metadata, models: [(metadata as { models: UsageByModel[] }).models[0]] },
        { template: "claude" },
      );
      assert.ok((priced.cost_usd ?? 0) > (mainOnly.cost_usd ?? 0));
    });

    it("counts only this turn's share of a model the earlier session also used", async () => {
      // Session A's cost-state: the sonnet subagent and an ai-title side-call already ran.
      // Every one of these keys comes back restored, not only the main model's.
      const restored = {
        "claude-haiku-4-5": mu(38, 590, 44_171, 15_886),
        "claude-haiku-4-5-20251001": mu(899, 8, 0, 0),
        "claude-sonnet-5": mu(706, 4, 0, 0),
      };
      const resumedTurn = {
        type: "result",
        subtype: "success",
        usage: {
          input_tokens: 18,
          output_tokens: 192,
          cache_read_input_tokens: 31_904,
          cache_creation_input_tokens: 678,
        },
        modelUsage: {
          "claude-haiku-4-5": mu(56, 782, 76_075, 16_564),
          "claude-haiku-4-5-20251001": mu(899, 8, 0, 0),
          "claude-sonnet-5": mu(1_412, 8, 0, 0),
        },
      };
      const emitted = await run([init, resumedTurn], true, restored);
      assert.deepEqual((emitted[0] as { models: UsageByModel[] }).models, [
        slice("claude-haiku-4-5", {
          input_tokens: 18,
          output_tokens: 192,
          cache_read_input_tokens: 31_904,
          cache_creation_input_tokens: 678,
        }),
        slice("claude-sonnet-5", { input_tokens: 706, output_tokens: 4 }),
      ]);
    });

    it("bills the next turn against the first, as in any stream", async () => {
      const restored = { "claude-haiku-4-5": mu(10, 44, 14_474, 0) };
      const first = {
        type: "result",
        subtype: "success",
        usage: {
          input_tokens: 18,
          output_tokens: 806,
          cache_read_input_tokens: 29_060,
          cache_creation_input_tokens: 664,
        },
        modelUsage: {
          "claude-haiku-4-5": mu(28, 850, 43_534, 664),
          "claude-sonnet-5": mu(706, 4, 0, 0),
        },
      };
      const second = {
        type: "result",
        subtype: "success",
        usage: {
          input_tokens: 10,
          output_tokens: 123,
          cache_read_input_tokens: 15_138,
          cache_creation_input_tokens: 1_061,
        },
        modelUsage: {
          "claude-haiku-4-5": mu(38, 973, 58_672, 1_725),
          "claude-sonnet-5": mu(706, 4, 0, 0),
        },
      };
      const emitted = await run([init, first, second], true, restored);
      assert.deepEqual((emitted[1] as { models: UsageByModel[] }).models, [
        slice("claude-haiku-4-5", {
          input_tokens: 10,
          output_tokens: 123,
          cache_read_input_tokens: 15_138,
          cache_creation_input_tokens: 1_061,
        }),
      ]);
    });

    it("prices the main model on its own usage when the restored totals lag the SDK's", async () => {
      // The SDK restored haiku's earlier totals, but the baseline read says nothing was
      // saved — a cost-state written after the read. The main slice would then carry the
      // whole earlier session; checked against `usage`, it is cut back to the turn's own.
      const resumedTurn = {
        type: "result",
        subtype: "success",
        usage: {
          input_tokens: 18,
          output_tokens: 806,
          cache_read_input_tokens: 29_060,
          cache_creation_input_tokens: 664,
        },
        modelUsage: {
          "claude-haiku-4-5": mu(28, 850, 43_534, 664),
          "claude-sonnet-5": mu(706, 4, 0, 0),
        },
      };
      const emitted = await run([init, resumedTurn], true, {});
      assert.deepEqual((emitted[0] as { models: UsageByModel[] }).models, [
        slice("claude-haiku-4-5", {
          input_tokens: 18,
          output_tokens: 806,
          cache_read_input_tokens: 29_060,
          cache_creation_input_tokens: 664,
        }),
        slice("claude-sonnet-5", { input_tokens: 706, output_tokens: 4 }),
      ]);
    });

    it("takes the whole counter as this turn's when the transcript saved no totals", async () => {
      // No cost-state line: the SDK starts from zero (verified live), so nothing is subtracted.
      const turn = {
        type: "result",
        subtype: "success",
        usage: {
          input_tokens: 10,
          output_tokens: 34,
          cache_read_input_tokens: 17_115,
          cache_creation_input_tokens: 46,
        },
        modelUsage: { "claude-haiku-4-5": mu(10, 34, 17_115, 46) },
      };
      const emitted = await run([init, turn], true, {});
      assert.deepEqual((emitted[0] as { models: UsageByModel[] }).models, [
        slice("claude-haiku-4-5", {
          input_tokens: 10,
          output_tokens: 34,
          cache_read_input_tokens: 17_115,
          cache_creation_input_tokens: 46,
        }),
      ]);
    });
  });
});

describe("claude template: restoredTotals", () => {
  const line = (sessionId: string, input: number) =>
    JSON.stringify({
      type: "cost-state",
      sessionId,
      totalCostUSD: 0.01,
      modelUsage: {
        "claude-haiku-4-5": {
          inputTokens: input,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    });
  const turn = JSON.stringify({ type: "assistant", sessionId: "s1", message: {} });

  it("takes the last cost-state line for the session", () => {
    const jsonl = [turn, line("s1", 10), turn, line("s1", 20), turn, ""].join("\n");
    assert.equal(restoredTotals(jsonl, "s1")["claude-haiku-4-5"]?.inputTokens, 20);
  });

  it("ignores a cost-state line saved under another session id, as the SDK does", () => {
    const jsonl = [line("s1", 10), line("other", 99)].join("\n");
    assert.equal(restoredTotals(jsonl, "s1")["claude-haiku-4-5"]?.inputTokens, 10);
    assert.deepEqual(restoredTotals(line("other", 99), "s1"), {});
  });

  it("skips a line the SDK's schema would reject, so an earlier valid one stands", () => {
    // The SDK validates cost-state and ignores an invalid line rather than resetting —
    // restoring from the earlier line. Reading the invalid one as "zero" would bill the
    // resumed turn for everything that earlier line holds.
    const noUsage = JSON.stringify({ type: "cost-state", sessionId: "s1", totalCostUSD: 0.02 });
    const partial = JSON.stringify({
      type: "cost-state",
      sessionId: "s1",
      modelUsage: { "claude-haiku-4-5": { inputTokens: 30 } },
    });
    const jsonl = [line("s1", 10), noUsage, partial].join("\n");
    assert.equal(restoredTotals(jsonl, "s1")["claude-haiku-4-5"]?.inputTokens, 10);
  });

  it("is empty when the transcript saved no totals, or a line doesn't parse", () => {
    assert.deepEqual(restoredTotals(turn, "s1"), {});
    assert.deepEqual(restoredTotals('{"type":"cost-state", truncated', "s1"), {});
  });
});

describe("claude template: reading the restored totals from disk", () => {
  let mod: typeof import("../templates/claude/src/lib/restored-totals.js");
  let composedDir: string;
  let cwd: string;

  before(async () => {
    composedDir = composeTemplate(
      resolvePath(fileURLToPath(import.meta.url), "../../templates"),
      "claude",
    ).composedDir;
    mod = await import(resolvePath(composedDir, "src/lib/restored-totals.js"));
    cwd = mkdtempSync(resolvePath(tmpdir(), "restored-totals-"));
  });

  after(() => {
    rmSync(composedDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  /** Writes `<cwd>/.claude/projects/p/<id>.jsonl`, where `findClaudeSessionFile` looks. */
  function transcript(lines: string[]): string {
    const id = randomUUID();
    const dir = resolvePath(cwd, ".claude/projects/p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolvePath(dir, `${id}.jsonl`),
      `${lines.map((l) => l.replaceAll("SID", id)).join("\n")}\n`,
    );
    return id;
  }
  const costState = (input: number) =>
    JSON.stringify({
      type: "cost-state",
      sessionId: "SID",
      modelUsage: {
        "claude-haiku-4-5": {
          inputTokens: input,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    });
  const filler = (bytes: number) =>
    JSON.stringify({ type: "assistant", sessionId: "SID", pad: "x".repeat(bytes) });

  it("is undefined when there is no transcript, so the raw-counter check runs instead", async () => {
    assert.equal(await mod.readRestoredTotals(cwd, randomUUID()), undefined);
  });

  it("is empty when the transcript saved no totals", async () => {
    assert.deepEqual(await mod.readRestoredTotals(cwd, transcript([filler(10)])), {});
  });

  it("finds the totals at the end of the transcript", async () => {
    const id = transcript([costState(5), filler(400_000), costState(7)]);
    assert.equal((await mod.readRestoredTotals(cwd, id))?.["claude-haiku-4-5"]?.inputTokens, 7);
  });

  it("reads the whole transcript when the tail holds none — a crashed last stream", async () => {
    const id = transcript([costState(5), filler(400_000)]);
    assert.equal((await mod.readRestoredTotals(cwd, id))?.["claude-haiku-4-5"]?.inputTokens, 5);
  });

  it("waits for a reaped stream's exit, but not forever", async () => {
    let exited = false;
    await mod.awaitPriorExit(
      new Promise((r) => setTimeout(r, 20)).then(() => {
        exited = true;
      }),
      5_000,
    );
    assert.ok(exited);
    const started = Date.now();
    await mod.awaitPriorExit(new Promise(() => {}), 30);
    assert.ok(Date.now() - started < 2_000);
    await mod.awaitPriorExit(Promise.reject(new Error("wedged")), 5_000);
    await mod.awaitPriorExit(undefined, 5_000);
  });
});
