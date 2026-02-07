import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { findTemplatesDir } from "../src/lib/template.js";

describe("protocol type conformance", () => {
  const canonical = readFileSync(resolve(import.meta.dirname, "../src/types.ts"), "utf-8");
  const agentSdkDir = findTemplatesDir("agent-sdk");
  const piDir = findTemplatesDir("pi");

  it("agent-sdk types.ts matches canonical src/types.ts", () => {
    const agentSdk = readFileSync(resolve(agentSdkDir, "src/lib/types.ts"), "utf-8");
    assert.equal(agentSdk, canonical);
  });

  it("pi types.ts matches canonical src/types.ts", () => {
    const pi = readFileSync(resolve(piDir, "src/lib/types.ts"), "utf-8");
    assert.equal(pi, canonical);
  });
});
