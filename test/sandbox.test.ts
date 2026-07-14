import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { _resetConfigCache } from "../packages/daemon/src/lib/config/setup.js";
import { voluteSystemDir } from "../packages/daemon/src/lib/mind/registry.js";
import {
  buildSandboxReadConfig,
  isSandboxEnabled,
  SandboxUnavailableError,
  shellEscape,
  wrapForSandbox,
} from "../packages/daemon/src/lib/mind/sandbox.js";

function configPath() {
  return resolve(voluteSystemDir(), "config.json");
}

function registryPath() {
  return resolve(voluteSystemDir(), "minds.json");
}

describe("sandbox", () => {
  const origSandbox = process.env.VOLUTE_SANDBOX;

  afterEach(() => {
    _resetConfigCache();
    try {
      unlinkSync(configPath());
    } catch {}
    try {
      unlinkSync(registryPath());
    } catch {}
    if (origSandbox === undefined) delete process.env.VOLUTE_SANDBOX;
    else process.env.VOLUTE_SANDBOX = origSandbox;
  });

  it("isSandboxEnabled returns false when no config exists", () => {
    delete process.env.VOLUTE_SANDBOX;
    assert.equal(isSandboxEnabled(), false);
  });

  it("isSandboxEnabled returns false when VOLUTE_SANDBOX=0", () => {
    process.env.VOLUTE_SANDBOX = "0";
    mkdirSync(voluteSystemDir(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ setup: { isolation: "sandbox" } }));
    assert.equal(isSandboxEnabled(), false);
  });

  it("isSandboxEnabled returns true when config has sandbox isolation", () => {
    delete process.env.VOLUTE_SANDBOX;
    mkdirSync(voluteSystemDir(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ setup: { isolation: "sandbox" } }));
    assert.equal(isSandboxEnabled(), true);
  });

  it("isSandboxEnabled returns false when config has user isolation", () => {
    delete process.env.VOLUTE_SANDBOX;
    mkdirSync(voluteSystemDir(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ setup: { isolation: "user" } }));
    assert.equal(isSandboxEnabled(), false);
  });

  it("isSandboxEnabled returns false when config has none isolation", () => {
    delete process.env.VOLUTE_SANDBOX;
    mkdirSync(voluteSystemDir(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ setup: { isolation: "none" } }));
    assert.equal(isSandboxEnabled(), false);
  });
});

describe("buildSandboxReadConfig", () => {
  const origHome = process.env.HOME;
  const origIsolation = process.env.VOLUTE_ISOLATION;

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origIsolation === undefined) delete process.env.VOLUTE_ISOLATION;
    else process.env.VOLUTE_ISOLATION = origIsolation;
  });

  it("denies user home directory", async () => {
    const userHome = process.env.HOME!;
    const { denyRead } = await buildSandboxReadConfig("alice", "/tmp/minds/alice");
    assert.ok(denyRead.includes(userHome), "should deny user home");
  });

  it("allows the mind's own directory", async () => {
    const { allowRead } = await buildSandboxReadConfig("alice", "/tmp/minds/alice");
    assert.ok(allowRead.includes("/tmp/minds/alice"), "should allow mind's own dir");
  });

  // A mind acts and speaks only through the volute CLI. Installed under $HOME
  // (nvm, npm --prefix=~) it falls under the blanket home denyRead, and the mind
  // is left mute — so the CLI's own paths must be re-allowed.
  it("allows the volute CLI even when it lives under the denied home dir", async () => {
    const home = mkdtempSync(resolve(tmpdir(), "volute-cli-"));
    const binDir = resolve(home, ".nvm/bin");
    const pkgDir = resolve(home, ".nvm/lib/node_modules/volute");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(resolve(pkgDir, "dist"), { recursive: true });
    writeFileSync(resolve(pkgDir, "package.json"), "{}");
    writeFileSync(resolve(pkgDir, "dist/cli.js"), "");
    symlinkSync(resolve(pkgDir, "dist/cli.js"), resolve(binDir, "volute"));

    const origPath = process.env.PATH;
    process.env.HOME = home;
    process.env.PATH = `${home}/.local/bin:${binDir}`;
    try {
      const { denyRead, allowRead } = await buildSandboxReadConfig("alice", "/tmp/minds/alice");
      assert.ok(denyRead.includes(home), "home is still denied");
      assert.ok(allowRead.includes(resolve(binDir, "volute")), "CLI shim must be readable");
      // The bundle loads sibling chunks and node_modules, so the file alone won't run.
      assert.ok(allowRead.includes(realpathSync(pkgDir)), "CLI package root must be readable");
      // Seatbelt resolves every symlink hop; npm's shim points through the node
      // prefix's lib/node_modules, so a denied hop there fails the whole lookup.
      assert.ok(
        allowRead.includes(resolve(dirname(process.execPath), "..")),
        "node install prefix must be readable (npm's symlink hop lives under it)",
      );
    } finally {
      if (origPath === undefined) delete process.env.PATH;
      else process.env.PATH = origPath;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("mind inside home dir is allowed via allowRead", async () => {
    const userHome = process.env.HOME!;
    const mindDir = resolve(userHome, ".volute", "minds", "alice");
    const { denyRead, allowRead } = await buildSandboxReadConfig("alice", mindDir);
    assert.ok(denyRead.includes(userHome), "home is denied");
    assert.ok(allowRead.includes(mindDir), "mind dir is re-allowed");
  });

  it("denies /Users on system installs (macOS)", async () => {
    process.env.VOLUTE_ISOLATION = "user";
    const { denyRead } = await buildSandboxReadConfig("alice", "/minds/alice");
    const usersDir = process.platform === "darwin" ? "/Users" : "/home";
    assert.ok(denyRead.includes(usersDir), "should deny all user dirs on system installs");
  });

  it("does not deny /Users on local installs", async () => {
    delete process.env.VOLUTE_ISOLATION;
    const { denyRead } = await buildSandboxReadConfig("alice", "/tmp/minds/alice");
    assert.ok(!denyRead.includes("/Users"), "should not deny /Users on local installs");
    assert.ok(!denyRead.includes("/home"), "should not deny /home on local installs");
  });

  it("returns empty denyRead when HOME is unset", async () => {
    process.env.HOME = "";
    const { denyRead, allowRead } = await buildSandboxReadConfig("alice", "/tmp/minds/alice");
    assert.equal(denyRead.length, 0, "no deny entries without HOME");
    assert.ok(allowRead.includes("/tmp/minds/alice"), "mind dir still allowed");
  });
});

describe("shellEscape", () => {
  it("wraps in single quotes", () => {
    assert.equal(shellEscape("hello"), "'hello'");
  });

  it("escapes embedded single quotes", () => {
    assert.equal(shellEscape("it's"), "'it'\\''s'");
  });

  it("handles spaces and special characters", () => {
    const escaped = shellEscape("hello world; rm -rf /");
    assert.equal(escaped, "'hello world; rm -rf /'");
  });

  it("handles backticks and dollar signs", () => {
    const escaped = shellEscape("$(whoami) `id`");
    assert.equal(escaped, "'$(whoami) `id`'");
  });

  it("handles empty strings", () => {
    assert.equal(shellEscape(""), "''");
  });
});

describe("wrapForSandbox passthrough", () => {
  it("returns original command when sandbox is not initialized", async () => {
    const [cmd, args] = await wrapForSandbox("/usr/bin/tsx", ["server.ts"], "/tmp/mind", "alice");
    assert.equal(cmd, "/usr/bin/tsx");
    assert.deepEqual(args, ["server.ts"]);
  });
});

describe("wrapForSandbox fail-closed", () => {
  const origSandbox = process.env.VOLUTE_SANDBOX;
  const origOptional = process.env.VOLUTE_SANDBOX_OPTIONAL;

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

  it("throws when sandbox is enabled but unavailable and opt-out is unset", async () => {
    // In unit tests the sandbox runtime is never initialized, so the manager is
    // null — this is exactly the "enabled but unavailable" degrade case.
    enableSandboxMode();
    delete process.env.VOLUTE_SANDBOX_OPTIONAL;
    await assert.rejects(
      () => wrapForSandbox("/usr/bin/tsx", ["server.ts"], "/tmp/mind", "alice"),
      SandboxUnavailableError,
    );
  });

  it("passes through when VOLUTE_SANDBOX_OPTIONAL=1", async () => {
    enableSandboxMode();
    process.env.VOLUTE_SANDBOX_OPTIONAL = "1";
    const [cmd, args] = await wrapForSandbox("/usr/bin/tsx", ["server.ts"], "/tmp/mind", "alice");
    assert.equal(cmd, "/usr/bin/tsx");
    assert.deepEqual(args, ["server.ts"]);
  });

  it("passes through when sandbox is disabled", async () => {
    process.env.VOLUTE_SANDBOX = "0";
    delete process.env.VOLUTE_SANDBOX_OPTIONAL;
    const [cmd, args] = await wrapForSandbox("/usr/bin/tsx", ["server.ts"], "/tmp/mind", "alice");
    assert.equal(cmd, "/usr/bin/tsx");
    assert.deepEqual(args, ["server.ts"]);
  });
});
