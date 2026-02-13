import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { summarizeTool } from "../src/lib/format-tool.js";

describe("summarizeTool", () => {
  it("uses path key", () => {
    assert.equal(summarizeTool("Read", { path: "/foo/bar.ts" }), "[Read /foo/bar.ts]");
  });

  it("uses command key", () => {
    assert.equal(summarizeTool("Bash", { command: "ls -la" }), "[Bash ls -la]");
  });

  it("uses query key", () => {
    assert.equal(summarizeTool("Grep", { query: "hello" }), "[Grep hello]");
  });

  it("uses url key", () => {
    assert.equal(
      summarizeTool("WebFetch", { url: "https://example.com" }),
      "[WebFetch https://example.com]",
    );
  });

  it("truncates at 60 chars", () => {
    const long = "a".repeat(100);
    const result = summarizeTool("Read", { path: long });
    assert.ok(result.length < 100);
    assert.ok(result.endsWith("...]"));
  });

  it("falls back to [name] for non-object input", () => {
    assert.equal(summarizeTool("Bash", "string input"), "[Bash]");
    assert.equal(summarizeTool("Bash", null), "[Bash]");
    assert.equal(summarizeTool("Bash", undefined), "[Bash]");
  });

  it("falls back to [name] for object without recognized keys", () => {
    assert.equal(summarizeTool("Custom", { foo: "bar" }), "[Custom]");
  });

  it("prefers path over command", () => {
    assert.equal(summarizeTool("Tool", { path: "/a", command: "b" }), "[Tool /a]");
  });
});
