import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { resolveModel } from "../templates/pi/src/lib/resolve-model.js";

describe("pi template resolveModel", () => {
  it("resolves a built-in model to its catalog entry", () => {
    const builtin = getBuiltinModels("anthropic")[0];
    const model = resolveModel(`anthropic:${builtin.id}`);
    assert.equal(model.id, builtin.id);
    // The real catalog entry has a friendly name, not the bare id.
    assert.equal(model.name, builtin.name);
  });

  it("falls back to a cloned sibling for a custom (non-catalog) id", () => {
    const model = resolveModel("anthropic:claude-future-99");
    assert.equal(model.id, "claude-future-99");
    assert.equal(model.name, "claude-future-99");
    assert.equal(model.api, "anthropic-messages");
    assert.ok(model.contextWindow > 0);
    assert.ok(model.maxTokens > 0);
    assert.equal(model.cost.input, 0);
  });

  it("prefers the built-in entry over a clone when the id exists", () => {
    const builtin =
      getBuiltinModels("anthropic").find((m) => m.id !== m.name) ??
      getBuiltinModels("anthropic")[0];
    const model = resolveModel(`anthropic:${builtin.id}`);
    // A clone would zero the cost and set name === id; the built-in does neither.
    assert.notEqual(model.name, model.id);
  });

  it("clones (does not prefix-match) a custom id that is a strict prefix of a built-in id", () => {
    // Mirrors the daemon's exact→custom ordering: a selected custom id must not be
    // silently resolved to a longer catalog id that merely starts with it.
    const anthropic = getBuiltinModels("anthropic");
    const ids = new Set(anthropic.map((m) => m.id));
    // A built-in whose one-char-shorter prefix is not itself a catalog id.
    const target = anthropic.find((m) => m.id.length > 1 && !ids.has(m.id.slice(0, -1)));
    assert.ok(target, "expected a suitable anthropic model");
    const prefix = target.id.slice(0, -1);
    const model = resolveModel(`anthropic:${prefix}`);
    assert.equal(model.id, prefix); // cloned with the exact typed id, not the longer built-in
    assert.equal(model.name, prefix); // a clone sets name === id
  });

  it("throws for an unknown provider", () => {
    assert.throws(() => resolveModel("not-a-real-provider:some-model"), /Unknown provider/);
  });
});
