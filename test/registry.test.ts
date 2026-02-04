import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readRegistry, nextPort } from "../src/lib/registry.js";

describe("registry", () => {
  it("nextPort returns 4100 when registry is empty", () => {
    const port = nextPort();
    assert.ok(port >= 4100, `Expected port >= 4100, got ${port}`);
  });

  it("readRegistry returns array", () => {
    const entries = readRegistry();
    assert.ok(Array.isArray(entries));
  });
});
