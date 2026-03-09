import assert from "node:assert/strict";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { voluteHome } from "../src/lib/registry.js";
import {
  buildDenyRead,
  isSandboxEnabled,
  shellEscape,
  wrapForSandbox,
} from "../src/lib/sandbox.js";

function configPath() {
  return resolve(voluteHome(), "config.json");
}

function registryPath() {
  return resolve(voluteHome(), "minds.json");
}

describe("sandbox", () => {
  const origSandbox = process.env.VOLUTE_SANDBOX;

  afterEach(() => {
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
    mkdirSync(voluteHome(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ setup: { isolation: "sandbox" } }));
    assert.equal(isSandboxEnabled(), false);
  });

  it("isSandboxEnabled returns true when config has sandbox isolation", () => {
    delete process.env.VOLUTE_SANDBOX;
    mkdirSync(voluteHome(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ setup: { isolation: "sandbox" } }));
    assert.equal(isSandboxEnabled(), true);
  });

  it("isSandboxEnabled returns false when config has user isolation", () => {
    delete process.env.VOLUTE_SANDBOX;
    mkdirSync(voluteHome(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ setup: { isolation: "user" } }));
    assert.equal(isSandboxEnabled(), false);
  });

  it("isSandboxEnabled returns false when config has none isolation", () => {
    delete process.env.VOLUTE_SANDBOX;
    mkdirSync(voluteHome(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ setup: { isolation: "none" } }));
    assert.equal(isSandboxEnabled(), false);
  });
});

describe("buildDenyRead", () => {
  const origMindsDir = process.env.VOLUTE_MINDS_DIR;
  const origHome = process.env.HOME;

  afterEach(() => {
    try {
      unlinkSync(resolve(voluteHome(), "minds.json"));
    } catch {}
    if (origMindsDir === undefined) delete process.env.VOLUTE_MINDS_DIR;
    else process.env.VOLUTE_MINDS_DIR = origMindsDir;
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
  });

  it("denies system state files", () => {
    const home = voluteHome();
    const deny = buildDenyRead("alice", resolve(home, "minds", "alice"));
    assert.ok(deny.includes(resolve(home, "state")));
    assert.ok(deny.includes(resolve(home, "volute.db")));
    assert.ok(deny.includes(resolve(home, "env.json")));
    assert.ok(deny.includes(resolve(home, "config.json")));
    assert.ok(deny.includes(resolve(home, "daemon.json")));
    assert.ok(deny.includes(resolve(home, "minds.json")));
    assert.ok(deny.includes(resolve(home, "systems.json")));
  });

  it("denies sensitive user directories", () => {
    const userHome = process.env.HOME!;
    const deny = buildDenyRead("alice", "/tmp/minds/alice");
    assert.ok(deny.includes(resolve(userHome, ".ssh")));
    assert.ok(deny.includes(resolve(userHome, ".aws")));
    assert.ok(deny.includes(resolve(userHome, ".gnupg")));
    assert.ok(deny.includes(resolve(userHome, ".config")));
  });

  it("denies other minds but not the current mind", () => {
    const home = voluteHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(
      resolve(home, "minds.json"),
      JSON.stringify([
        { name: "alice", port: 4100 },
        { name: "bob", port: 4101 },
        { name: "carol", port: 4102 },
      ]),
    );

    const mindsDir = resolve(home, "minds");
    const deny = buildDenyRead("alice", resolve(mindsDir, "alice"));
    assert.ok(!deny.includes(resolve(mindsDir, "alice")), "should not deny own dir");
    assert.ok(deny.includes(resolve(mindsDir, "bob")), "should deny bob");
    assert.ok(deny.includes(resolve(mindsDir, "carol")), "should deny carol");
  });

  it("handles variant names correctly", () => {
    const home = voluteHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(
      resolve(home, "minds.json"),
      JSON.stringify([
        { name: "alice", port: 4100 },
        { name: "bob", port: 4101 },
      ]),
    );

    const mindsDir = resolve(home, "minds");
    const deny = buildDenyRead("alice@experiment", resolve(mindsDir, "alice"));
    assert.ok(!deny.includes(resolve(mindsDir, "alice")), "should not deny base mind dir");
    assert.ok(deny.includes(resolve(mindsDir, "bob")), "should deny other minds");
  });

  it("handles missing minds.json without crashing", () => {
    const deny = buildDenyRead("alice", "/tmp/minds/alice");
    // Should still have system state and sensitive dirs
    assert.ok(deny.length > 0);
  });

  it("handles corrupt minds.json without crashing", () => {
    const home = voluteHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(resolve(home, "minds.json"), "not json");

    const deny = buildDenyRead("alice", "/tmp/minds/alice");
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
