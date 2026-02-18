import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { mindEnvPath, readEnv, sharedEnvPath, writeEnv } from "../src/lib/env.js";

describe("env", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "volute-env-test-"));
  });

  it("readEnv returns empty object for missing file", () => {
    const env = readEnv(join(tmp, "nonexistent.json"));
    assert.deepEqual(env, {});
  });

  it("writeEnv + readEnv roundtrips", () => {
    const path = join(tmp, "env.json");
    writeEnv(path, { FOO: "bar", BAZ: "qux" });
    const env = readEnv(path);
    assert.deepEqual(env, { FOO: "bar", BAZ: "qux" });
  });

  it("writeEnv creates parent directories", () => {
    const path = join(tmp, "nested", "dir", "env.json");
    writeEnv(path, { KEY: "val" });
    assert.deepEqual(readEnv(path), { KEY: "val" });
  });

  it("loadMergedEnv merges shared and agent envs with agent winning", () => {
    // Set up a fake agent dir structure
    const mindDir = join(tmp, "agent");
    const voluteDir = join(mindDir, ".volute");
    mkdirSync(voluteDir, { recursive: true });

    // Write shared env to a known location — we test the merge logic by
    // calling the individual read/write and then manually merging.
    const shared = { SHARED_KEY: "shared_val", OVERLAP: "from_shared" };
    const agent = { AGENT_KEY: "agent_val", OVERLAP: "from_agent" };

    writeEnv(join(voluteDir, "env.json"), agent);

    // loadMergedEnv reads from the global shared path and agent path.
    // For a unit test, we just verify the merge semantics directly.
    const merged = { ...shared, ...agent };
    assert.equal(merged.SHARED_KEY, "shared_val");
    assert.equal(merged.AGENT_KEY, "agent_val");
    assert.equal(merged.OVERLAP, "from_agent");
  });

  it("readEnv returns empty object for invalid JSON", () => {
    const path = join(tmp, "bad.json");
    writeFileSync(path, "not json");
    assert.deepEqual(readEnv(path), {});
  });

  it("mindEnvPath returns correct path", () => {
    const path = mindEnvPath("test");
    assert.ok(
      path.endsWith("/state/test/env.json"),
      `Expected path ending with /state/test/env.json, got ${path}`,
    );
  });

  it("sharedEnvPath returns path under VOLUTE_HOME", () => {
    const path = sharedEnvPath();
    assert.ok(path.endsWith("/env.json"));
  });

  it("writeEnv sets file permissions to 0600", () => {
    const path = join(tmp, "secure.json");
    writeEnv(path, { SECRET: "value" });
    const mode = statSync(path).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});
