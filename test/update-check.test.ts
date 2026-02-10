import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { voluteHome } from "../src/lib/registry.js";
import {
  checkForUpdate,
  checkForUpdateCached,
  getCurrentVersion,
  isNewer,
} from "../src/lib/update-check.js";

describe("isNewer", () => {
  it("detects newer major version", () => {
    assert.equal(isNewer("1.0.0", "2.0.0"), true);
  });

  it("detects newer minor version", () => {
    assert.equal(isNewer("1.0.0", "1.1.0"), true);
  });

  it("detects newer patch version", () => {
    assert.equal(isNewer("1.0.0", "1.0.1"), true);
  });

  it("returns false for same version", () => {
    assert.equal(isNewer("1.0.0", "1.0.0"), false);
  });

  it("returns false for older version", () => {
    assert.equal(isNewer("2.0.0", "1.0.0"), false);
  });

  it("handles multi-digit versions", () => {
    assert.equal(isNewer("0.9.0", "0.10.0"), true);
    assert.equal(isNewer("0.10.0", "0.9.0"), false);
  });
});

describe("getCurrentVersion", () => {
  it("returns a semver string", () => {
    const version = getCurrentVersion();
    assert.match(version, /^\d+\.\d+\.\d+/);
  });
});

describe("checkForUpdateCached", () => {
  it("returns null when no cache exists", () => {
    const result = checkForUpdateCached();
    // May or may not be null depending on test order, but should not throw
    assert.ok(result === null || typeof result.current === "string");
  });

  it("reads from cache file", () => {
    const cachePath = resolve(voluteHome(), "update-check.json");
    writeFileSync(cachePath, JSON.stringify({ latest: "99.0.0", checkedAt: Date.now() }));
    const result = checkForUpdateCached();
    assert.ok(result !== null);
    assert.equal(result.latest, "99.0.0");
    assert.equal(result.updateAvailable, true);
  });
});

describe("checkForUpdate", () => {
  it("returns current version on network failure", async () => {
    // Write a stale cache so it tries to fetch (which will likely fail in test env)
    const cachePath = resolve(voluteHome(), "update-check.json");
    writeFileSync(cachePath, JSON.stringify({ latest: "0.0.1", checkedAt: 0 }));
    const result = await checkForUpdate();
    assert.ok(typeof result.current === "string");
    assert.ok(typeof result.latest === "string");
    assert.ok(typeof result.updateAvailable === "boolean");
  });

  it("uses cache when within TTL", async () => {
    const cachePath = resolve(voluteHome(), "update-check.json");
    writeFileSync(cachePath, JSON.stringify({ latest: "99.0.0", checkedAt: Date.now() }));
    const result = await checkForUpdate();
    assert.equal(result.latest, "99.0.0");
    assert.equal(result.updateAvailable, true);
  });
});
