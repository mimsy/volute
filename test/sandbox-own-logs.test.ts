import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { _resetConfigCache } from "../packages/daemon/src/lib/config/setup.js";
import { stateDir, voluteSystemDir } from "../packages/daemon/src/lib/mind/registry.js";
import { initSandbox, wrapForSandbox } from "../packages/daemon/src/lib/mind/sandbox.js";

// Real-sandbox check that a sandboxed mind can read its own server log — and nothing
// else in its state dir (#938). The volute-mind skill points minds at
// $VOLUTE_STATE_DIR/logs/mind.log; under the sandbox's blanket $HOME denyRead that
// pointer was to a file the mind couldn't open.
//
// Its own file for the same reason as sandbox-heredoc.test.ts: initSandbox()'s
// module-level state must not leak into sandbox.test.ts.
describe("sandbox: a mind's own logs (real exec)", () => {
  it("reads its own mind.log, but not the rest of its state dir", async (t) => {
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    const { errors } = SandboxManager.checkDependencies();
    if (errors.length && process.platform !== "darwin") {
      t.skip(`sandbox runtime unavailable: ${errors.join(", ")}`);
      return;
    }

    mkdirSync(voluteSystemDir(), { recursive: true });
    writeFileSync(
      resolve(voluteSystemDir(), "config.json"),
      JSON.stringify({ setup: { isolation: "sandbox" } }),
    );
    _resetConfigCache();
    await initSandbox();

    const state = stateDir("alice");
    mkdirSync(resolve(state, "logs"), { recursive: true });
    writeFileSync(resolve(state, "logs", "mind.log"), "own-log-ok\n");
    writeFileSync(resolve(state, "secret.json"), "state-secret\n");
    const mindDir = mkdtempSync(resolve(dirname(voluteSystemDir()), "sandbox-logs-"));

    // Deny the test's volute home the way a real install's $HOME denyRead covers
    // ~/.volute, so the allowRead is what's actually under test.
    const origHome = process.env.HOME;
    process.env.HOME = dirname(voluteSystemDir());
    try {
      const exec = async (cmd: string) => {
        const [c, a] = await wrapForSandbox("bash", ["-c", cmd], mindDir, "alice", [mindDir]);
        return spawnSync(c, a, { encoding: "utf-8" });
      };
      const own = await exec(`cat ${resolve(state, "logs", "mind.log")}`);
      assert.equal(own.status, 0, `own log unreadable inside sandbox: ${own.stderr}`);
      assert.match(own.stdout, /own-log-ok/);

      const other = await exec(`cat ${resolve(state, "secret.json")}`);
      assert.notEqual(other.status, 0, "the rest of the state dir must stay unreadable");
      assert.doesNotMatch(other.stdout, /state-secret/);
    } finally {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      rmSync(mindDir, { recursive: true, force: true });
    }
  });
});
