import assert from "node:assert/strict";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  _resetConfigCache,
  type GlobalConfig,
  isSetupComplete,
  mindLimitError,
  readGlobalConfig,
  setupStatus,
  setupUrl,
  writeGlobalConfig,
} from "../packages/daemon/src/lib/config/setup.js";
import { voluteSystemDir } from "../packages/daemon/src/lib/mind/registry.js";
import { generateSystemUnit } from "../src/commands/setup.js";

function configPath() {
  return resolve(voluteSystemDir(), "config.json");
}

function registryPath() {
  return resolve(voluteSystemDir(), "minds.json");
}

function cleanup() {
  _resetConfigCache();
  try {
    unlinkSync(configPath());
  } catch {}
  try {
    unlinkSync(registryPath());
  } catch {}
}

describe("setup config", () => {
  afterEach(cleanup);

  it("readGlobalConfig returns empty object when config.json does not exist", () => {
    assert.deepEqual(readGlobalConfig(), {});
  });

  it("readGlobalConfig reads all fields", () => {
    mkdirSync(voluteSystemDir(), { recursive: true });
    const config: GlobalConfig = {
      name: "test",
      hostname: "0.0.0.0",
      port: 5000,
      setup: {
        type: "local",
        mindsDir: "/tmp/minds",
        isolation: "sandbox",
        service: false,
      },
    };
    writeFileSync(configPath(), JSON.stringify(config));
    const result = readGlobalConfig();
    assert.equal(result.name, "test");
    assert.equal(result.hostname, "0.0.0.0");
    assert.equal(result.port, 5000);
    assert.equal(result.setup?.type, "local");
    assert.equal(result.setup?.isolation, "sandbox");
  });

  it("writeGlobalConfig creates the file", () => {
    const config: GlobalConfig = { name: "myserver", port: 1618 };
    writeGlobalConfig(config);
    const result = readGlobalConfig();
    assert.equal(result.name, "myserver");
    assert.equal(result.port, 1618);
  });

  it("isSetupComplete returns false when no config exists", () => {
    assert.equal(isSetupComplete(), false);
  });

  it("isSetupComplete returns false when config has no setup field", () => {
    mkdirSync(voluteSystemDir(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ hostname: "localhost" }));
    assert.equal(isSetupComplete(), false);
  });

  it("isSetupComplete treats a legacy config (setup block, no setupCompleted flag) as complete", () => {
    // Predates the setupCompleted flag; a setup block with no flag reads as complete.
    writeGlobalConfig({
      name: "test",
      setup: { type: "local", mindsDir: "/tmp", isolation: "sandbox", service: false },
    });
    assert.equal(isSetupComplete(), true);
  });

  it("isSetupComplete returns true when setupCompleted is true", () => {
    writeGlobalConfig({
      name: "test",
      setup: { type: "local", mindsDir: "/tmp", isolation: "sandbox", service: false },
      setupCompleted: true,
    });
    assert.equal(isSetupComplete(), true);
  });

  it("isSetupComplete returns false while setup is in progress (setupCompleted === false)", () => {
    writeGlobalConfig({
      name: "test",
      setup: { type: "local", mindsDir: "/tmp", isolation: "sandbox", service: false },
      setupCompleted: false,
    });
    assert.equal(isSetupComplete(), false);
  });
});

describe("setupStatus", () => {
  afterEach(cleanup);

  it("returns 'none' when no config exists", () => {
    assert.equal(setupStatus(), "none");
  });

  it("returns 'none' when config has no setup field", () => {
    writeGlobalConfig({ name: "test" });
    assert.equal(setupStatus(), "none");
  });

  it("returns 'in-progress' after `volute setup` ran but the wizard is unfinished", () => {
    // This is the state `volute setup` leaves behind: config written, browser
    // wizard not yet completed. The old strict gate misreported it as "not set up".
    writeGlobalConfig({
      name: "test",
      setup: { type: "local", mindsDir: "/tmp", isolation: "sandbox", service: false },
      setupCompleted: false,
    });
    assert.equal(setupStatus(), "in-progress");
  });

  it("returns 'complete' for a legacy config missing the setupCompleted flag", () => {
    writeGlobalConfig({
      name: "test",
      setup: { type: "local", mindsDir: "/tmp", isolation: "sandbox", service: false },
    });
    assert.equal(setupStatus(), "complete");
  });

  it("returns 'complete' when setupCompleted is true", () => {
    writeGlobalConfig({
      name: "test",
      setup: { type: "local", mindsDir: "/tmp", isolation: "sandbox", service: false },
      setupCompleted: true,
    });
    assert.equal(setupStatus(), "complete");
  });
});

describe("setupUrl", () => {
  afterEach(cleanup);

  it("defaults to 127.0.0.1:1618 when config is empty", () => {
    assert.equal(setupUrl(), "http://127.0.0.1:1618");
  });

  it("uses the configured port and rewrites a wildcard host to localhost", () => {
    writeGlobalConfig({ hostname: "0.0.0.0", port: 9000 });
    assert.equal(setupUrl(), "http://localhost:9000");
  });

  it("preserves a concrete hostname", () => {
    writeGlobalConfig({ hostname: "myhost.local", port: 1618 });
    assert.equal(setupUrl(), "http://myhost.local:1618");
  });

  it("rewrites the IPv6 wildcard host to localhost", () => {
    writeGlobalConfig({ hostname: "::", port: 1618 });
    assert.equal(setupUrl(), "http://localhost:1618");
  });

  it("brackets a bare IPv6 hostname", () => {
    writeGlobalConfig({ hostname: "::1", port: 1618 });
    assert.equal(setupUrl(), "http://[::1]:1618");
  });
});

describe("mindLimitError", () => {
  it("allows creation when the limit is unset (unlimited)", () => {
    assert.equal(mindLimitError(0, undefined), null);
    assert.equal(mindLimitError(9999, undefined), null);
  });

  it("allows creation while under the cap", () => {
    assert.equal(mindLimitError(0, 5), null);
    assert.equal(mindLimitError(4, 5), null);
  });

  it("rejects at the cap with an actionable message", () => {
    const err = mindLimitError(5, 5);
    assert.ok(err);
    assert.match(err, /Mind limit reached \(5\/5\)/);
    assert.match(err, /admin can raise maxMinds/i);
  });

  it("rejects over the cap", () => {
    assert.ok(mindLimitError(6, 5));
  });
});

describe("generateSystemUnit", () => {
  const unit = () => generateSystemUnit("/usr/local/bin/volute", 1618, "0.0.0.0");

  it("runs the daemon in the foreground with the system paths", () => {
    const text = unit();
    assert.match(text, /ExecStart=\/usr\/local\/bin\/volute up --foreground --port 1618/);
    assert.ok(text.includes("Environment=VOLUTE_HOME=/var/lib/volute"));
    assert.ok(text.includes("Environment=VOLUTE_MINDS_DIR=/minds"));
    assert.ok(text.includes("Environment=VOLUTE_ISOLATION=user"));
  });

  it("keeps the hardening that does not conflict with mind isolation", () => {
    const text = unit();
    assert.ok(text.includes("ProtectSystem=true"));
    assert.ok(text.includes("ReadWritePaths=/var/lib/volute /minds"));
    assert.ok(text.includes("PrivateTmp=yes"));
  });

  // #832: RestrictSUIDSGID=yes EPERMs git's adjust_shared_perm() setgid chmods in the
  // `--shared=group` pages repo, so `_system` worktrees never provision and publishing
  // fails with "unable to create temporary file". systemd has no per-path carve-out.
  it("does not set RestrictSUIDSGID, which breaks shared pages under user isolation", () => {
    assert.ok(!unit().includes("RestrictSUIDSGID"));
  });
});
