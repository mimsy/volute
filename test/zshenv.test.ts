import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { syncMindZshenv } from "../packages/daemon/src/lib/mind/zshenv.js";

const execFileAsync = promisify(execFile);
const env = { VOLUTE_MIND_TOKEN: "live-token", VOLUTE_MIND: "m", PATH: "/usr/bin", HOME: "/h" };

/** A mind dir with an empty home/, as syncMindZshenv sees one. */
function mindDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "zshenv-"));
  mkdirSync(resolve(dir, "home"));
  return dir;
}

describe("syncMindZshenv", () => {
  it("writes VOLUTE_* vars and PATH for a codex mind", async () => {
    const dir = mindDir();
    await syncMindZshenv(dir, "m", "codex", env);
    const content = readFileSync(resolve(dir, "home/.zshenv"), "utf-8");
    assert.match(content, /export VOLUTE_MIND_TOKEN="live-token"/);
    assert.match(content, /export PATH="\/usr\/bin"/);
    assert.doesNotMatch(content, /HOME/);
  });

  // #1123: the daemon is root under user isolation, and a mind can plant a link.
  it("refuses a symlink planted at home/.zshenv instead of writing through it", async () => {
    const dir = mindDir();
    const victim = resolve(mkdtempSync(resolve(tmpdir(), "zshenv-victim-")), "victim");
    writeFileSync(victim, "untouched\n");
    symlinkSync(victim, resolve(dir, "home/.zshenv"));
    await assert.rejects(syncMindZshenv(dir, "m", "codex", env), /ELOOP/);
    assert.equal(readFileSync(victim, "utf-8"), "untouched\n");
  });

  it("refuses a link or FIFO at .zshenv on a non-codex mind: no read through it, no hang", async () => {
    const dir = mindDir();
    const victim = resolve(mkdtempSync(resolve(tmpdir(), "zshenv-victim-")), "victim");
    writeFileSync(victim, 'export VOLUTE_MIND_TOKEN="x"\n');
    symlinkSync(victim, resolve(dir, "home/.zshenv"));
    await assert.rejects(syncMindZshenv(dir, "m", "claude", env), /ELOOP/);
    assert.equal(existsSync(victim), true);

    const fifoDir = mindDir();
    await execFileAsync("mkfifo", [resolve(fifoDir, "home/.zshenv")]);
    await assert.rejects(syncMindZshenv(fifoDir, "m", "claude", env), /single link/);
  });

  // A mind switched from codex to another template keeps the file, and zsh sources
  // it on every command — overriding the live token with a long-revoked one.
  it("removes a stale daemon-written .zshenv from a non-codex mind", async () => {
    const dir = mindDir();
    await syncMindZshenv(dir, "m", "codex", { ...env, VOLUTE_MIND_TOKEN: "revoked-token" });
    await syncMindZshenv(dir, "m", "claude", env);
    assert.equal(existsSync(resolve(dir, "home/.zshenv")), false);
  });

  it("leaves a mind's own .zshenv alone", async () => {
    const dir = mindDir();
    const path = resolve(dir, "home/.zshenv");
    writeFileSync(path, "export EDITOR=vim\n");
    await syncMindZshenv(dir, "m", "claude", env);
    assert.equal(readFileSync(path, "utf-8"), "export EDITOR=vim\n");
  });
});
