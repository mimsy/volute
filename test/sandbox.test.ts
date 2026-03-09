import assert from "node:assert/strict";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { voluteHome } from "../src/lib/registry.js";
import { isSandboxEnabled } from "../src/lib/sandbox.js";

function configPath() {
  return resolve(voluteHome(), "config.json");
}

describe("sandbox", () => {
  const origSandbox = process.env.VOLUTE_SANDBOX;

  afterEach(() => {
    try {
      unlinkSync(configPath());
    } catch {}
    if (origSandbox === undefined) delete process.env.VOLUTE_SANDBOX;
    else process.env.VOLUTE_SANDBOX = origSandbox;
  });

  it("isSandboxEnabled returns false when no config exists", () => {
    delete process.env.VOLUTE_SANDBOX;
    assert.equal(isSandboxEnabled(), false);
  });

  it("isSandboxEnabled returns false when VOLUTE_SANDBOX=0", () => {
    process.env.VOLUTE_SANDBOX = "0";
    mkdirSync(voluteHome(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ setup: { isolation: "sandbox" } }));
    assert.equal(isSandboxEnabled(), false);
  });

  it("isSandboxEnabled returns true when config has sandbox isolation", () => {
    delete process.env.VOLUTE_SANDBOX;
    mkdirSync(voluteHome(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ setup: { isolation: "sandbox" } }));
    assert.equal(isSandboxEnabled(), true);
  });

  it("isSandboxEnabled returns false when config has user isolation", () => {
    delete process.env.VOLUTE_SANDBOX;
    mkdirSync(voluteHome(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ setup: { isolation: "user" } }));
    assert.equal(isSandboxEnabled(), false);
  });

  it("isSandboxEnabled returns false when config has none isolation", () => {
    delete process.env.VOLUTE_SANDBOX;
    mkdirSync(voluteHome(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ setup: { isolation: "none" } }));
    assert.equal(isSandboxEnabled(), false);
  });
});
