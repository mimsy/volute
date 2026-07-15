import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { _resetConfigCache } from "../packages/daemon/src/lib/config/setup.js";
import { voluteSystemDir } from "../packages/daemon/src/lib/mind/registry.js";
import { initSandbox, wrapForSandbox } from "../packages/daemon/src/lib/mind/sandbox.js";

// Real-sandbox regression test for the here-document temp-file bug: macOS ships
// bash 3.2, which writes here-doc temp files to /tmp and ignores $TMPDIR, so a
// sandboxed mind's `cat <<'X'` failed with "cannot create temp file for here
// document: operation not permitted" until shellTempWritePaths() granted the tmp
// root. On Linux, modern bash uses the sandbox's TMPDIR=/tmp/claude (already
// whitelisted by sandbox-runtime), so this also guards that path from regressing.
//
// This actually spawns a sandboxed bash, so it needs the sandbox runtime's OS
// deps (bwrap on Linux). It skips cleanly when they're absent.
//
// Lives in its own file so initSandbox()'s module-level state doesn't leak into
// sandbox.test.ts's passthrough assertions (node runs each test file in its own
// process).
describe("sandbox here-document (real exec)", () => {
  it("runs a bash here-document inside the sandbox without EPERM", async (t) => {
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    const { errors } = SandboxManager.checkDependencies();
    // On macOS the seatbelt profile does its own glob matching, so dependency
    // "errors" (missing ripgrep) are non-fatal; on Linux they mean no bwrap, so
    // the mind can't be sandboxed at all — nothing to assert.
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

    const mindDir = mkdtempSync(resolve(tmpdir(), "sandbox-heredoc-"));
    try {
      const [cmd, args] = await wrapForSandbox(
        "bash",
        ["-c", "cat <<'MSG'\nsandbox-heredoc-ok\nMSG"],
        mindDir,
        "alice",
        [mindDir],
      );
      const { status, stdout, stderr } = spawnSync(cmd, args, { encoding: "utf-8" });
      assert.equal(status, 0, `here-document failed inside sandbox: ${stderr}`);
      assert.match(stdout, /sandbox-heredoc-ok/);
    } finally {
      rmSync(mindDir, { recursive: true, force: true });
    }
  });
});
