import assert from "node:assert/strict";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { _resetConfigCache } from "../packages/daemon/src/lib/config/setup.js";
import { voluteSystemDir } from "../packages/daemon/src/lib/mind/registry.js";
import { SandboxUnavailableError } from "../packages/daemon/src/lib/mind/sandbox.js";
import { spawnServer } from "../packages/daemon/src/lib/mind/spawn-server.js";

// The merge-verification path spawns a mind-authored server.ts. It must be
// wrapped the same way startMind wraps it (sandbox/isolation) so mind code never
// runs in the daemon's trust domain.
describe("spawnServer verification wrapping", () => {
  const origSandbox = process.env.VOLUTE_SANDBOX;
  const origOptional = process.env.VOLUTE_SANDBOX_OPTIONAL;

  function configPath() {
    return resolve(voluteSystemDir(), "config.json");
  }

  function enableSandboxMode() {
    delete process.env.VOLUTE_SANDBOX;
    mkdirSync(voluteSystemDir(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ setup: { isolation: "sandbox" } }));
    _resetConfigCache();
  }

  afterEach(() => {
    _resetConfigCache();
    try {
      unlinkSync(configPath());
    } catch {}
    if (origSandbox === undefined) delete process.env.VOLUTE_SANDBOX;
    else process.env.VOLUTE_SANDBOX = origSandbox;
    if (origOptional === undefined) delete process.env.VOLUTE_SANDBOX_OPTIONAL;
    else process.env.VOLUTE_SANDBOX_OPTIONAL = origOptional;
  });

  it("refuses to spawn a mind server unsandboxed under sandbox mode", async () => {
    enableSandboxMode();
    delete process.env.VOLUTE_SANDBOX_OPTIONAL;
    await assert.rejects(
      () => spawnServer("/tmp/variant-dir", 0, { mindName: "alice", template: "claude" }),
      SandboxUnavailableError,
    );
  });

  it("does not wrap when no mindName is given (legacy callers unaffected)", async () => {
    enableSandboxMode();
    // No mindName → no wrap attempt. The tsx bin under a nonexistent dir can't be
    // spawned, so the attached spawn resolves null rather than throwing.
    const result = await spawnServer("/tmp/nonexistent-spawn-dir", 0);
    assert.equal(result, null);
  });

  it("skips sandbox wrap for codex-template minds", async () => {
    enableSandboxMode();
    delete process.env.VOLUTE_SANDBOX_OPTIONAL;
    // Codex is excluded from sandbox wrapping, so no SandboxUnavailableError —
    // the (missing) tsx bin just fails to spawn and resolves null.
    const result = await spawnServer("/tmp/nonexistent-codex-dir", 0, {
      mindName: "alice",
      template: "codex",
    });
    assert.equal(result, null);
  });
});
