import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { resolveMindName } from "../src/lib/resolve-mind-name.js";

describe("resolveMindName", () => {
  const original = process.env.VOLUTE_MIND;
  afterEach(() => {
    if (original === undefined) delete process.env.VOLUTE_MIND;
    else process.env.VOLUTE_MIND = original;
  });

  it("returns flags.mind when provided", () => {
    assert.equal(resolveMindName({ mind: "my-mind" }), "my-mind");
  });

  it("falls back to VOLUTE_MIND env var", () => {
    process.env.VOLUTE_MIND = "env-mind";
    assert.equal(resolveMindName({}), "env-mind");
  });

  it("prefers flags.mind over VOLUTE_MIND", () => {
    process.env.VOLUTE_MIND = "env-mind";
    assert.equal(resolveMindName({ mind: "flag-mind" }), "flag-mind");
  });
});
