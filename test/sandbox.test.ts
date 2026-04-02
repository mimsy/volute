import assert from "node:assert/strict";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { _resetConfigCache } from "../packages/daemon/src/lib/config/setup.js";
import { voluteSystemDir } from "../packages/daemon/src/lib/mind/registry.js";
import {
  buildSandboxReadConfig,
  isSandboxEnabled,
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
