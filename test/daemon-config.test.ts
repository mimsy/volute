import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { writeDaemonConfig } from "../packages/daemon/src/daemon.js";

describe("writeDaemonConfig", () => {
  it("keeps daemon.json host-readable (0644) and puts the token in a 0600 file", () => {
    // daemon.json (port/hostname) must be readable by a non-root host CLI on a
    // system install; the admin token must never be world-readable.
    const dir = mkdtempSync(resolve(tmpdir(), "volute-daemon-cfg-"));
    const configPath = resolve(dir, "daemon.json");
    const tokenPath = resolve(dir, "daemon-token");
    // Pre-create daemon.json at 0600 (as v0.41.1 left it) to prove the write relaxes it.
    writeFileSync(configPath, "{}", { mode: 0o600 });

    writeDaemonConfig(dir, { port: 1618, hostname: "127.0.0.1" }, "super-secret");

    assert.equal(statSync(configPath).mode & 0o777, 0o644, "daemon.json should be 0644");
    const config = readFileSync(configPath, "utf-8");
    assert.ok(!config.includes("super-secret"), "daemon.json must not contain the token");
    assert.ok(config.includes("1618"), "daemon.json keeps port/hostname");

    assert.equal(statSync(tokenPath).mode & 0o777, 0o600, "daemon-token should be 0600");
    assert.equal(readFileSync(tokenPath, "utf-8").trim(), "super-secret");
  });

  it("tightens a pre-existing token file left at loose perms", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "volute-daemon-cfg-"));
    const tokenPath = resolve(dir, "daemon-token");
    writeFileSync(tokenPath, "old", { mode: 0o644 });
    writeDaemonConfig(dir, { port: 1618, hostname: "127.0.0.1" }, "new-token");
    assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
  });
});
