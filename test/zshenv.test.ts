import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { syncMindZshenv } from "../packages/daemon/src/lib/mind/zshenv.js";

const env = { VOLUTE_MIND_TOKEN: "live-token", VOLUTE_MIND: "m", PATH: "/usr/bin", HOME: "/h" };

describe("syncMindZshenv", () => {
  it("writes VOLUTE_* vars and PATH for a codex mind", () => {
    const home = mkdtempSync(resolve(tmpdir(), "zshenv-"));
    syncMindZshenv(home, "codex", env);
    const content = readFileSync(resolve(home, ".zshenv"), "utf-8");
    assert.match(content, /export VOLUTE_MIND_TOKEN="live-token"/);
    assert.match(content, /export PATH="\/usr\/bin"/);
    assert.doesNotMatch(content, /HOME/);
  });

  // A mind switched from codex to another template keeps the file, and zsh sources
  // it on every command — overriding the live token with a long-revoked one.
  it("removes a stale daemon-written .zshenv from a non-codex mind", () => {
    const home = mkdtempSync(resolve(tmpdir(), "zshenv-"));
    syncMindZshenv(home, "codex", { ...env, VOLUTE_MIND_TOKEN: "revoked-token" });
    syncMindZshenv(home, "claude", env);
    assert.equal(existsSync(resolve(home, ".zshenv")), false);
  });

  it("leaves a mind's own .zshenv alone", () => {
    const home = mkdtempSync(resolve(tmpdir(), "zshenv-"));
    const path = resolve(home, ".zshenv");
    writeFileSync(path, "export EDITOR=vim\n");
    syncMindZshenv(home, "claude", env);
    assert.equal(readFileSync(path, "utf-8"), "export EDITOR=vim\n");
  });
});
