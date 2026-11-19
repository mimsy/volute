import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { registeredCustomModels, resolveModel } from "../templates/pi/src/lib/resolve-model.js";

describe("pi template resolveModel", () => {
  it("resolves a built-in model to its catalog entry", () => {
    const builtin = getBuiltinModels("anthropic")[0];
    const model = resolveModel(`anthropic:${builtin.id}`);
    assert.equal(model.id, builtin.id);
    // The real catalog entry has a friendly name, not the bare id.
    assert.equal(model.name, builtin.name);
  });

  it("clones a sibling for a registered custom id, keeping the sibling's rates", () => {
    const model = resolveModel("anthropic:claude-future-99", ["anthropic:claude-future-99"]);
    assert.equal(model.id, "claude-future-99");
    assert.equal(model.name, "claude-future-99");
    assert.equal(model.api, "anthropic-messages");
    assert.ok(model.contextWindow > 0);
    assert.ok(model.maxTokens > 0);
    // Priced at the sibling's rates rather than zero, so its turns stay metered.
    assert.ok(model.cost.input > 0);
    assert.ok(model.cost.output > 0);
  });

  it("refuses an id that is neither in the catalog nor registered, telling the mind why", () => {
    assert.throws(
      () => resolveModel("anthropic:claude-future-99"),
      (err: Error) =>
        /"anthropic:claude-future-99", is neither in Volute's model catalog nor registered/.test(
          err.message,
        ) &&
        /spend cap/.test(err.message) &&
        /home\/\.config\/config\.json/.test(err.message),
    );
    // Registered for a different provider doesn't count.
    assert.throws(
      () => resolveModel("anthropic:claude-future-99", ["openai:claude-future-99"]),
      /neither in Volute's model catalog/,
    );
  });

  it("prefers the built-in entry over a clone when the id exists", () => {
    const builtin =
      getBuiltinModels("anthropic").find((m) => m.id !== m.name) ??
      getBuiltinModels("anthropic")[0];
    const model = resolveModel(`anthropic:${builtin.id}`, [`anthropic:${builtin.id}`]);
    // A clone would set name === id; the built-in doesn't.
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
    const model = resolveModel(`anthropic:${prefix}`, [`anthropic:${prefix}`]);
    assert.equal(model.id, prefix); // cloned with the exact typed id, not the longer built-in
    assert.equal(model.name, prefix); // a clone sets name === id
  });

  it("throws for a registered custom id whose provider has no catalog to clone from", () => {
    assert.throws(
      () => resolveModel("not-a-real-provider:some-model", ["not-a-real-provider:some-model"]),
      /Unknown provider/,
    );
  });

  it("the shipped default model resolves, and is the one agent.ts falls back to", () => {
    // agent.ts falls back to a model when a pi mind's config names none; if that one were
    // refused, such a mind could not start at all. It is the shipped config.json's model,
    // which the daemon also assumes when pricing a pi mind whose config it can't read.
    const shipped: string = JSON.parse(
      readFileSync(new URL("../templates/pi/home/.config/config.json", import.meta.url), "utf8"),
    ).model;
    const agentSrc = readFileSync(new URL("../templates/pi/src/agent.ts", import.meta.url), "utf8");
    assert.ok(
      agentSrc.includes(`process.env.PI_MODEL || "${shipped}"`),
      "agent.ts must fall back to the shipped config's model",
    );
    const [provider, ...rest] = shipped.split(":");
    assert.equal(resolveModel(shipped).id, rest.join(":"));
    assert.equal(resolveModel(shipped).provider, provider);
  });
});

describe("pi template registeredCustomModels", () => {
  it("reads the daemon's JSON list, keeping only strings", () => {
    assert.deepEqual(registeredCustomModels('["anthropic:a", 3, "openai:b"]'), [
      "anthropic:a",
      "openai:b",
    ]);
  });

  it("is empty when unset or unreadable, so nothing beyond the catalog runs", () => {
    assert.deepEqual(registeredCustomModels(undefined), []);
    assert.deepEqual(registeredCustomModels("not json"), []);
    assert.deepEqual(registeredCustomModels('{"a":1}'), []);
  });
});
