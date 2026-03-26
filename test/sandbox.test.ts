import assert from "node:assert/strict";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { _resetConfigCache } from "../packages/daemon/src/lib/config/setup.js";
import {
  addMind,
  removeMind,
  voluteHome,
  voluteSystemDir,
} from "../packages/daemon/src/lib/mind/registry.js";
import {
  buildDenyRead,
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

describe("buildDenyRead", () => {
  const origMindsDir = process.env.VOLUTE_MINDS_DIR;
  const origHome = process.env.HOME;

  afterEach(() => {
    try {
      unlinkSync(resolve(voluteSystemDir(), "minds.json"));
    } catch {}
    if (origMindsDir === undefined) delete process.env.VOLUTE_MINDS_DIR;
    else process.env.VOLUTE_MINDS_DIR = origMindsDir;
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
  });

  it("denies system directory", async () => {
    const home = voluteHome();
    const deny = await buildDenyRead("alice", resolve(home, "minds", "alice"));
    assert.ok(deny.includes(voluteSystemDir()), "should block entire system directory");
  });

  it("denies sensitive user directories", async () => {
    const userHome = process.env.HOME!;
    const deny = await buildDenyRead("alice", "/tmp/minds/alice");
    assert.ok(deny.includes(resolve(userHome, ".ssh")));
    assert.ok(deny.includes(resolve(userHome, ".aws")));
    assert.ok(deny.includes(resolve(userHome, ".gnupg")));
    assert.ok(deny.includes(resolve(userHome, ".config")));
  });

  it("denies other minds but not the current mind", async () => {
    const home = voluteHome();
    await addMind("alice", 4100);
    await addMind("bob", 4101);
    await addMind("carol", 4102);

    const mindsDir = resolve(home, "minds");
    const deny = await buildDenyRead("alice", resolve(mindsDir, "alice"));
    assert.ok(!deny.includes(resolve(mindsDir, "alice")), "should not deny own dir");
    assert.ok(deny.includes(resolve(mindsDir, "bob")), "should deny bob");
    assert.ok(deny.includes(resolve(mindsDir, "carol")), "should deny carol");
    await removeMind("alice");
    await removeMind("bob");
    await removeMind("carol");
  });

  it("handles split names correctly", async () => {
    const home = voluteHome();
    await addMind("alice", 4100);
    await addMind("bob", 4101);

    const mindsDir = resolve(home, "minds");
    const deny = await buildDenyRead("alice", resolve(mindsDir, "alice"));
    assert.ok(!deny.includes(resolve(mindsDir, "alice")), "should not deny base mind dir");
    assert.ok(deny.includes(resolve(mindsDir, "bob")), "should deny other minds");
    await removeMind("alice");
    await removeMind("bob");
  });

  it("handles empty registry without crashing", async () => {
    const deny = await buildDenyRead("alice", "/tmp/minds/alice");
    // Should still have system state and sensitive dirs
    assert.ok(deny.length > 0);
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
