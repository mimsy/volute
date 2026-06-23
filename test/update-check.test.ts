import assert from "node:assert/strict";
import { unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { voluteSystemDir } from "../packages/daemon/src/lib/mind/registry.js";
import {
  analyzeInstallPath,
  checkForUpdate,
  checkForUpdateCached,
  getCurrentVersion,
  isNewer,
} from "../packages/daemon/src/lib/update-check.js";

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

  it("strips pre-release suffix (release is newer than pre-release)", () => {
    assert.equal(isNewer("1.0.0-beta.1", "1.0.0"), true);
  });

  it("strips pre-release suffix (pre-release is not newer than release)", () => {
    assert.equal(isNewer("1.0.0", "1.0.0-rc.1"), false);
  });
});

describe("analyzeInstallPath", () => {
  it("derives prefix from a Homebrew-style global install", () => {
    const r = analyzeInstallPath("/opt/homebrew/lib/node_modules/volute/dist/cli.js");
    assert.equal(r.isLinked, false);
    assert.equal(r.packageRoot, "/opt/homebrew/lib/node_modules/volute");
    assert.equal(r.prefix, "/opt/homebrew");
  });

  it("derives prefix from an nvm-style global install", () => {
    const r = analyzeInstallPath(
      "/Users/me/.nvm/versions/node/v20.0.0/lib/node_modules/volute/dist/cli.js",
    );
    assert.equal(r.prefix, "/Users/me/.nvm/versions/node/v20.0.0");
    assert.equal(r.packageRoot, "/Users/me/.nvm/versions/node/v20.0.0/lib/node_modules/volute");
  });

  it("handles a prefix without a lib/ directory (windows-style)", () => {
    const r = analyzeInstallPath("/usr/local/node_modules/volute/dist/cli.js");
    assert.equal(r.prefix, "/usr/local");
  });

  it("flags a source checkout / npm link as linked", () => {
    const r = analyzeInstallPath("/Users/me/src/volute/dist/cli.js");
    assert.equal(r.isLinked, true);
    assert.equal(r.prefix, null);
    assert.equal(r.packageRoot, null);
  });
});

describe("getCurrentVersion", () => {
  it("returns a semver string", () => {
    const version = getCurrentVersion();
    assert.match(version, /^\d+\.\d+\.\d+/);
  });
});

describe("checkForUpdateCached", () => {
  const cacheFile = () => resolve(voluteSystemDir(), "update-check.json");

  afterEach(() => {
    try {
      unlinkSync(cacheFile());
    } catch {}
  });

  it("returns null when no cache exists", () => {
    const result = checkForUpdateCached();
    assert.equal(result, null);
  });

  it("reads from cache file", () => {
    writeFileSync(cacheFile(), JSON.stringify({ latest: "99.0.0", checkedAt: Date.now() }));
    const result = checkForUpdateCached();
    assert.ok(result !== null);
    assert.equal(result.latest, "99.0.0");
    assert.equal(result.updateAvailable, true);
  });

  it("returns null for corrupt cache", () => {
    writeFileSync(cacheFile(), "not json");
    const result = checkForUpdateCached();
    assert.equal(result, null);
  });
});

describe("checkForUpdate", () => {
  const cacheFile = () => resolve(voluteSystemDir(), "update-check.json");

  afterEach(() => {
    try {
      unlinkSync(cacheFile());
    } catch {}
  });

  it("returns current version on network failure", async () => {
    // Write a stale cache so it tries to fetch (which will likely fail in test env)
    writeFileSync(cacheFile(), JSON.stringify({ latest: "0.0.1", checkedAt: 0 }));
    const result = await checkForUpdate();
    assert.ok(typeof result.current === "string");
    assert.ok(typeof result.latest === "string");
    assert.ok(typeof result.updateAvailable === "boolean");
  });

  it("uses cache when within TTL", async () => {
    writeFileSync(cacheFile(), JSON.stringify({ latest: "99.0.0", checkedAt: Date.now() }));
    const result = await checkForUpdate();
    assert.equal(result.latest, "99.0.0");
    assert.equal(result.updateAvailable, true);
  });

  it("force=true bypasses cache even when within TTL", async () => {
    writeFileSync(cacheFile(), JSON.stringify({ latest: "99.0.0", checkedAt: Date.now() }));
    const result = await checkForUpdate(true);
    // With force=true, cache should be skipped — either fetches fresh or fails
    if (result.checkFailed) {
      assert.equal(result.updateAvailable, false);
    } else {
      assert.notEqual(result.latest, "99.0.0");
    }
  });

  it("does not throw on stale cache (checkFailed or fresh result)", async () => {
    writeFileSync(cacheFile(), JSON.stringify({ latest: "0.0.1", checkedAt: 0 }));
    const result = await checkForUpdate();
    // Network may or may not be available — either checkFailed is set or we get a fresh result
    if (result.checkFailed) {
      assert.equal(result.updateAvailable, false);
    } else {
      assert.ok(typeof result.latest === "string");
    }
  });
});
