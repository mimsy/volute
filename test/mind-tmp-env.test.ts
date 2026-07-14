import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mindTmpDir, mindTmpEnv } from "../packages/daemon/src/lib/mind/registry.js";

describe("mindTmpEnv", () => {
  it("points TMPDIR at the mind's own tmp dir", () => {
    const env = mindTmpEnv("/minds/alice");
    assert.equal(env.TMPDIR, mindTmpDir("/minds/alice"));
  });

  // Claude Code builds its Bash scratch dir as `${CLAUDE_CODE_TMPDIR ?? "/tmp"}/claude-<uid>`
  // and ignores TMPDIR. Left unset, it mkdirs under the real /tmp, which is outside the
  // mind's sandbox allowWrite set — every Bash tool call then dies with EPERM.
  it("points CLAUDE_CODE_TMPDIR at the mind's own tmp dir so the sandbox allows it", () => {
    const env = mindTmpEnv("/minds/alice");
    assert.equal(env.CLAUDE_CODE_TMPDIR, mindTmpDir("/minds/alice"));
  });
});
