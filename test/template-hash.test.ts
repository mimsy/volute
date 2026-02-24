import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeTemplateHash } from "../src/lib/template-hash.js";

describe("computeTemplateHash", () => {
  it("returns a 64-char hex string (SHA-256)", () => {
    const hash = computeTemplateHash("claude");
    assert.equal(hash.length, 64);
    assert.match(hash, /^[a-f0-9]{64}$/);
  });

  it("is deterministic (same input = same output)", () => {
    const hash1 = computeTemplateHash("claude");
    const hash2 = computeTemplateHash("claude");
    assert.equal(hash1, hash2);
  });

  it("produces different hashes for different templates", () => {
    const claudeHash = computeTemplateHash("claude");
    const piHash = computeTemplateHash("pi");
    assert.notEqual(claudeHash, piHash);
  });
});
