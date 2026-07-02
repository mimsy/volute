import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { writeDaemonConfig } from "../packages/daemon/src/daemon.js";

describe("writeDaemonConfig", () => {
  it("locks daemon.json to owner-only (0600), even when pre-existing 0644", () => {
    // daemon.json holds the daemon admin token — must never be world-readable.
    const dir = mkdtempSync(resolve(tmpdir(), "volute-daemon-cfg-"));
    const path = resolve(dir, "daemon.json");
    // Pre-create with loose perms to prove the chmod tightens them (writeFileSync's
    // `mode` only applies on creation).
    writeFileSync(path, "{}", { mode: 0o644 });
    writeDaemonConfig(path, { port: 1618, hostname: "127.0.0.1", token: "secret" });
    const mode = statSync(path).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  });
});
