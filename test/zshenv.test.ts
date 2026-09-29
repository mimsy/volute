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
import { composeMindEnv } from "../packages/daemon/src/lib/daemon/mind-manager.js";
import { syncMindZshenv, wantsDaemonZshenv } from "../packages/daemon/src/lib/mind/zshenv.js";

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
    await syncMindZshenv(dir, "m", true, env);
    const content = readFileSync(resolve(dir, "home/.zshenv"), "utf-8");
    assert.match(content, /export VOLUTE_MIND_TOKEN="live-token"/);
    assert.match(content, /export PATH="\/usr\/bin"/);
    assert.doesNotMatch(content, /HOME/);
  });

  it("a daemon started from a mind's shell doesn't pin every codex thread to its slug (#1173)", async (t) => {
    // codex runs each command in `zsh -c` with the per-session shell environment
    // (VOLUTE_SESSION among it) and ZDOTDIR=home, so zsh sources this file *after* the
    // env is set: a slug written here would override every thread's own. The daemon's
    // own VOLUTE_SESSION must not reach the composed mind env this file is written from.
    const saved = process.env.VOLUTE_SESSION;
    process.env.VOLUTE_SESSION = "main";
    let composed: Record<string, string | undefined>;
    try {
      composed = composeMindEnv({
        name: "zsh-1173",
        baseName: "zsh-1173",
        dir: "/tmp/zsh-1173",
        port: 4195,
        mindToken: "tok",
        isolationMode: "none",
      });
    } finally {
      if (saved === undefined) delete process.env.VOLUTE_SESSION;
      else process.env.VOLUTE_SESSION = saved;
    }
    const dir = mindDir();
    await syncMindZshenv(dir, "m", true, composed);

    const zsh = ["/bin/zsh", "/usr/bin/zsh"].find((p) => existsSync(p));
    if (!zsh) return t.skip("zsh not installed");
    const { stdout } = await execFileAsync(zsh, ["-lc", 'printf %s "$VOLUTE_SESSION"'], {
      env: { ZDOTDIR: resolve(dir, "home"), VOLUTE_SESSION: "#bardo", PATH: "/usr/bin:/bin" },
    });
    assert.equal(stdout, "#bardo");
  });

  // #1123: the daemon is root under user isolation, and a mind can plant a link.
  it("refuses a symlink planted at home/.zshenv instead of writing through it", async () => {
    const dir = mindDir();
    const victim = resolve(mkdtempSync(resolve(tmpdir(), "zshenv-victim-")), "victim");
    writeFileSync(victim, "untouched\n");
    symlinkSync(victim, resolve(dir, "home/.zshenv"));
    await assert.rejects(syncMindZshenv(dir, "m", true, env), /ELOOP/);
    assert.equal(readFileSync(victim, "utf-8"), "untouched\n");
  });

  it("refuses a link or FIFO at a .zshenv it would remove: no read through it, no hang", async () => {
    const dir = mindDir();
    const victim = resolve(mkdtempSync(resolve(tmpdir(), "zshenv-victim-")), "victim");
    writeFileSync(victim, 'export VOLUTE_MIND_TOKEN="x"\n');
    symlinkSync(victim, resolve(dir, "home/.zshenv"));
    await assert.rejects(syncMindZshenv(dir, "m", false, env), /ELOOP/);
    assert.equal(existsSync(victim), true);

    const fifoDir = mindDir();
    await execFileAsync("mkfifo", [resolve(fifoDir, "home/.zshenv")]);
    await assert.rejects(syncMindZshenv(fifoDir, "m", false, env), /single link/);
  });

  // A mind switched from codex to another template, or upgraded past #1232, keeps the
  // file, and zsh sources it on every command — overriding the live token with a
  // long-revoked one.
  it("removes a stale daemon-written .zshenv when it isn't wanted", async () => {
    const dir = mindDir();
    await syncMindZshenv(dir, "m", true, { ...env, VOLUTE_MIND_TOKEN: "revoked-token" });
    await syncMindZshenv(dir, "m", false, env);
    assert.equal(existsSync(resolve(dir, "home/.zshenv")), false);
  });

  it("leaves a mind's own .zshenv alone", async () => {
    const dir = mindDir();
    const path = resolve(dir, "home/.zshenv");
    writeFileSync(path, "export EDITOR=vim\n");
    await syncMindZshenv(dir, "m", false, env);
    assert.equal(readFileSync(path, "utf-8"), "export EDITOR=vim\n");
  });
});

/** Give a mind dir a src/agent.ts; the shipped codex template's by default. */
function withAgentSource(dir: string, text = readFileSync(SHIPPED_CODEX_AGENT, "utf-8")) {
  mkdirSync(resolve(dir, "src"), { recursive: true });
  writeFileSync(resolve(dir, "src/agent.ts"), text);
}
const SHIPPED_CODEX_AGENT = resolve(import.meta.dirname, "../templates/codex/src/agent.ts");
/** How the codex template configured its shell before #1232: login shells, no opt-out. */
const LOGIN_SHELL_AGENT = 'shell_environment_policy: { inherit: "all" },\n';

// #1237: since #1232 codex runs `<shell> -c` and commands inherit the mind's env whole,
// so the file — the mind's live token, in its home — is written only for a codex mind
// still on the login-shell template.
describe("wantsDaemonZshenv", () => {
  it("is false for a codex mind on the shipped template", async () => {
    const dir = mindDir();
    withAgentSource(dir);
    assert.equal(await wantsDaemonZshenv(dir, "m", "codex"), false);
  });

  it("is true for a codex mind still on a login-shell template", async () => {
    const dir = mindDir();
    withAgentSource(dir, LOGIN_SHELL_AGENT);
    assert.equal(await wantsDaemonZshenv(dir, "m", "codex"), true);
  });

  it("is false for every other template, whatever its source says", async () => {
    const dir = mindDir();
    withAgentSource(dir, LOGIN_SHELL_AGENT);
    assert.equal(await wantsDaemonZshenv(dir, "m", "claude"), false);
    assert.equal(await wantsDaemonZshenv(dir, "m", undefined), false);
  });

  it("writes no token file when the source is absent or a link", async () => {
    const dir = mindDir();
    assert.equal(await wantsDaemonZshenv(dir, "m", "codex"), false);
    const target = resolve(mkdtempSync(resolve(tmpdir(), "zshenv-agent-")), "agent.ts");
    writeFileSync(target, LOGIN_SHELL_AGENT);
    mkdirSync(resolve(dir, "src"));
    symlinkSync(target, resolve(dir, "src/agent.ts"));
    assert.equal(await wantsDaemonZshenv(dir, "m", "codex"), false);
  });

  it("an upgrade past #1232 retires the file the old template was given", async () => {
    const dir = mindDir();
    withAgentSource(dir, LOGIN_SHELL_AGENT);
    await syncMindZshenv(dir, "m", await wantsDaemonZshenv(dir, "m", "codex"), env);
    assert.equal(existsSync(resolve(dir, "home/.zshenv")), true);
    withAgentSource(dir);
    await syncMindZshenv(dir, "m", await wantsDaemonZshenv(dir, "m", "codex"), env);
    assert.equal(existsSync(resolve(dir, "home/.zshenv")), false);
  });

  it("without the file, codex's `zsh -c` still sees the mind's env and skill commands", async (t) => {
    const zsh = ["/bin/zsh", "/usr/bin/zsh"].find((p) => existsSync(p));
    if (!zsh) return t.skip("zsh not installed");
    const dir = mindDir();
    const bin = resolve(dir, "home/.local/bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(resolve(bin, "skill-cmd"), "#!/bin/sh\necho skill-ok\n", { mode: 0o755 });
    // As codex hands it over: the mind's env, inherited whole, plus the policy's `set`
    // and whatever codex itself prepends to PATH.
    const { stdout } = await execFileAsync(
      zsh,
      ["-c", 'printf "%s|%s|%s|" "$VOLUTE_MIND_TOKEN" "$VOLUTE_SESSION" "$PATH"; skill-cmd'],
      {
        env: {
          VOLUTE_MIND_TOKEN: "live-token",
          VOLUTE_SESSION: "#bardo",
          PATH: `/codex/arg0:${bin}:/usr/bin:/bin`,
          ZDOTDIR: resolve(dir, "home"),
          HOME: resolve(dir, "home"),
        },
      },
    );
    assert.equal(stdout, `live-token|#bardo|/codex/arg0:${bin}:/usr/bin:/bin|skill-ok\n`);
  });
});
