import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { migrateToSystemDir } from "../src/lib/migrate-system-dir.js";
import { voluteHome, voluteSystemDir } from "../src/lib/registry.js";

describe("migrateToSystemDir", () => {
  let home: string;
  let systemDir: string;

  beforeEach(() => {
    home = voluteHome();
    systemDir = voluteSystemDir();
    mkdirSync(home, { recursive: true });
  });

  afterEach(() => {
    // Clean up migrated files
    for (const f of ["minds.json", "config.json", "env.json", "daemon.json", "daemon.pid"]) {
      try {
        rmSync(resolve(home, f));
      } catch {}
      try {
        rmSync(resolve(systemDir, f));
      } catch {}
    }
    try {
      rmSync(resolve(home, "state"), { recursive: true, force: true });
    } catch {}
    try {
      rmSync(resolve(systemDir, "state"), { recursive: true, force: true });
    } catch {}
  });

  it("moves files from root to system/", () => {
    writeFileSync(resolve(home, "minds.json"), "[]");
    writeFileSync(resolve(home, "config.json"), "{}");
    writeFileSync(resolve(home, "env.json"), "{}");

    migrateToSystemDir();

    assert.ok(existsSync(resolve(systemDir, "minds.json")));
    assert.ok(existsSync(resolve(systemDir, "config.json")));
    assert.ok(existsSync(resolve(systemDir, "env.json")));
    assert.ok(!existsSync(resolve(home, "minds.json")));
    assert.ok(!existsSync(resolve(home, "config.json")));
    assert.ok(!existsSync(resolve(home, "env.json")));
  });

  it("moves state/ directory", () => {
    const oldState = resolve(home, "state", "alice");
    mkdirSync(oldState, { recursive: true });
    writeFileSync(resolve(oldState, "env.json"), "{}");

    migrateToSystemDir();

    assert.ok(existsSync(resolve(systemDir, "state", "alice", "env.json")));
    assert.ok(!existsSync(resolve(home, "state")));
  });

  it("skips files that already exist in system/", () => {
    mkdirSync(systemDir, { recursive: true });
    writeFileSync(resolve(home, "minds.json"), "old");
    writeFileSync(resolve(systemDir, "minds.json"), "new");

    migrateToSystemDir();

    assert.equal(readFileSync(resolve(systemDir, "minds.json"), "utf-8"), "new");
    // Old file stays since we didn't move it
    assert.ok(existsSync(resolve(home, "minds.json")));
  });

  it("is idempotent", () => {
    writeFileSync(resolve(home, "minds.json"), "[]");

    migrateToSystemDir();
    migrateToSystemDir();

    assert.ok(existsSync(resolve(systemDir, "minds.json")));
    assert.equal(readFileSync(resolve(systemDir, "minds.json"), "utf-8"), "[]");
  });

  it("handles missing files gracefully", () => {
    // No files to migrate — should not throw
    migrateToSystemDir();
    assert.ok(existsSync(systemDir));
  });
});
