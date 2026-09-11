import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

  it("detached spawn ignores stale 'listening on' lines from earlier attempts (#654)", async () => {
    // The verify path appends every attempt's output to the same
    // .mind/logs/mind.log; matching the first "listening on :PORT" in the file
    // returned a previous (dead) server's port, failing every re-verify.
    const dir = mkdtempSync(join(tmpdir(), "spawn-detached-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(
        join(dir, "src", "server.ts"),
        'console.log("listening on :43219");\nsetTimeout(() => {}, 15000);\n',
      );
      // `node --import tsx` resolves tsx from the spawn cwd
      symlinkSync(resolve(process.cwd(), "node_modules"), join(dir, "node_modules"), "dir");
      // Seed the log with a prior attempt's line
      mkdirSync(join(dir, ".mind", "logs"), { recursive: true });
      writeFileSync(join(dir, ".mind", "logs", "mind.log"), "listening on :1\n");

      const result = await spawnServer(dir, 0, { detached: true });
      try {
        assert.ok(result, "spawn should succeed");
        assert.equal(result.actualPort, 43219);
      } finally {
        if (result?.child.pid) {
          try {
            process.kill(-result.child.pid, "SIGKILL");
          } catch {
            try {
              process.kill(result.child.pid, "SIGKILL");
            } catch {}
          }
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not hand the daemon's admin token to the mind-authored server (#966)", async () => {
    // src/server.ts is a file the mind edits, and the mind can make the daemon run it:
    // POST /:name/variants/:variant/merge reaches this verify spawn, with verification
    // on by default. A bare spawn inherits the daemon's environment, token included.
    // This spawns a real server.ts that reports what it can see, exactly as a mind's
    // own edited one could.
    const dir = mkdtempSync(join(tmpdir(), "spawn-env-"));
    const savedToken = process.env.VOLUTE_DAEMON_TOKEN;
    const savedHost = process.env.HOST_ONLY_SECRET;
    process.env.VOLUTE_DAEMON_TOKEN = "super-secret-admin";
    process.env.HOST_ONLY_SECRET = "ambient-host-secret";
    let result: Awaited<ReturnType<typeof spawnServer>> = null;
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      const seen = join(dir, "seen.txt");
      writeFileSync(
        join(dir, "src", "server.ts"),
        [
          'import { writeFileSync } from "node:fs";',
          'const token = process.env.VOLUTE_DAEMON_TOKEN ?? "";',
          'const host = process.env.HOST_ONLY_SECRET ?? "";',
          `writeFileSync(${JSON.stringify(seen)}, "token=[" + token + "]\\nhost=[" + host + "]");`,
          'console.log("listening on :43221");',
          "setTimeout(() => {}, 15000);",
        ].join("\n"),
      );
      symlinkSync(resolve(process.cwd(), "node_modules"), join(dir, "node_modules"), "dir");

      result = await spawnServer(dir, 0, { detached: true });
      assert.ok(result, "spawn should succeed");
      assert.equal(readFileSync(seen, "utf-8"), "token=[]\nhost=[]");
    } finally {
      if (result?.child.pid) {
        try {
          process.kill(-result.child.pid, "SIGKILL");
        } catch {
          try {
            process.kill(result.child.pid, "SIGKILL");
          } catch {}
        }
      }
      if (savedToken === undefined) delete process.env.VOLUTE_DAEMON_TOKEN;
      else process.env.VOLUTE_DAEMON_TOKEN = savedToken;
      if (savedHost === undefined) delete process.env.HOST_ONLY_SECRET;
      else process.env.HOST_ONLY_SECRET = savedHost;
      rmSync(dir, { recursive: true, force: true });
    }
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
