import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fixModelEscapes } from "../packages/daemon/src/lib/util/fix-model-escapes.js";

describe("fixModelEscapes", () => {
  it("replaces \\! with ! unconditionally", () => {
    assert.equal(fixModelEscapes("hello\\!", false), "hello!");
    assert.equal(fixModelEscapes("a\\!b\\!c", false), "a!b!c");
  });

  it("leaves normal text unchanged", () => {
    assert.equal(fixModelEscapes("hello world", false), "hello world");
    assert.equal(fixModelEscapes("no escapes here!", false), "no escapes here!");
  });

  it("does not unescape \\n when disabled", () => {
    assert.equal(fixModelEscapes("line1\\nline2", false), "line1\\nline2");
  });

  it("unescapes \\n and \\t when enabled", () => {
    assert.equal(fixModelEscapes("line1\\nline2", true), "line1\nline2");
    assert.equal(fixModelEscapes("col1\\tcol2", true), "col1\tcol2");
  });

  it("handles mixed escapes", () => {
    assert.equal(fixModelEscapes("hello\\! world\\nbye", true), "hello! world\nbye");
    assert.equal(fixModelEscapes("hello\\! world\\nbye", false), "hello! world\\nbye");
  });

  it("handles empty string", () => {
    assert.equal(fixModelEscapes("", false), "");
    assert.equal(fixModelEscapes("", true), "");
  });

  it("preserves real newlines and tabs", () => {
    assert.equal(fixModelEscapes("line1\nline2", false), "line1\nline2");
    assert.equal(fixModelEscapes("line1\nline2", true), "line1\nline2");
  });
});
