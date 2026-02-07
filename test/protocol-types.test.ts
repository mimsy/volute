import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { findTemplatesRoot } from "../src/lib/template.js";

describe("protocol type conformance", () => {
  const canonical = readFileSync(resolve(import.meta.dirname, "../src/types.ts"), "utf-8");
  const templatesRoot = findTemplatesRoot();

  it("_base types.ts matches canonical src/types.ts", () => {
    const base = readFileSync(resolve(templatesRoot, "_base/src/lib/types.ts"), "utf-8");
    assert.equal(base, canonical);
  });
});
