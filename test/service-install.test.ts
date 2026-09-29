import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  generateSystemPlist,
  generateSystemUnit,
  planServiceFile,
  readServiceFile,
} from "../packages/daemon/src/lib/config/service-install.js";
import type { VoluteInstall } from "../packages/daemon/src/lib/update-check.js";
import { prefixWritable } from "../src/commands/update.js";

const BIN = "/usr/local/bin/volute";

describe("generateSystemUnit ProtectHome", () => {
  // Decided by the path, not by whoever's HOME the sudo'd process happens to have:
  // a wrong `ProtectHome=yes` hides the daemon's own binary from its unit.
  for (const bin of [
    "/home/host/.nvm/versions/node/v22/bin/volute",
    "/root/.nvm/versions/node/v22/bin/volute",
    "/run/user/1000/volute",
  ]) {
    it(`omits ProtectHome for a binary under ${bin.split("/")[1]}/`, () => {
      assert.ok(!generateSystemUnit(bin, 1618, "0.0.0.0").includes("ProtectHome"));
    });
  }

  it("sets ProtectHome for a binary outside home directories", () => {
    assert.ok(generateSystemUnit(BIN, 1618, "0.0.0.0").includes("ProtectHome=yes"));
  });
});

describe("planServiceFile (systemd)", () => {
  const current = generateSystemUnit(BIN, 1618, "0.0.0.0");
  const plan = (text: string) => {
    const p = planServiceFile("systemd", text);
    assert.equal(p.status, "reviewed");
    if (p.status !== "reviewed") throw new Error("unreachable");
    return p;
  };

  it("leaves a unit this version wrote alone", () => {
    const p = plan(current);
    assert.equal(p.rewrite, null);
    assert.equal(p.customised, null);
  });

  // #1224: bardo's unit predates #879 and still carries RestrictSUIDSGID=yes.
  it("brings an otherwise-stock pre-#879 unit back to stock", () => {
    const old = current.replace("PrivateTmp=yes\n", "PrivateTmp=yes\nRestrictSUIDSGID=yes\n");
    const p = plan(old);
    assert.equal(p.rewrite, current);
    assert.deepEqual(
      p.migrated.map((m) => m.line),
      ["RestrictSUIDSGID=yes"],
    );
    assert.equal(p.customised, null);
  });

  it("removes a shared CLAUDE_CONFIG_DIR a #56-era unit carries", () => {
    const old = current.replace(
      "Environment=VOLUTE_ISOLATION=user\n",
      "Environment=VOLUTE_ISOLATION=user\nEnvironment=CLAUDE_CONFIG_DIR=/var/lib/volute/.claude\n",
    );
    assert.equal(plan(old).rewrite, current);
  });

  // A regenerated unit that fails to start takes every mind down: a host's own
  // changes are reported, never overwritten.
  it("keeps a host's customisation and removes only the migrated line", () => {
    const tuned = current.replace("RestartSec=5", "RestartSec=10");
    const old = tuned.replace("PrivateTmp=yes\n", "PrivateTmp=yes\nRestrictSUIDSGID=yes\n");
    const p = plan(old);
    assert.equal(p.rewrite, tuned);
    assert.deepEqual(p.customised, { missing: ["RestartSec=5"], extra: ["RestartSec=10"] });
  });

  it("reports a customised unit without rewriting it when no migration applies", () => {
    const p = plan(current.replace("RestartSec=5", "RestartSec=10"));
    assert.equal(p.rewrite, null);
    assert.deepEqual(p.customised, { missing: ["RestartSec=5"], extra: ["RestartSec=10"] });
  });

  it("never adds a line the installed unit lacks", () => {
    // A unit written without ProtectHome (setup's old homedir() check) keeps running without it.
    const p = plan(
      current
        .replace("ProtectHome=yes\n", "")
        .replace("PrivateTmp=yes\n", "PrivateTmp=yes\nRestrictSUIDSGID=yes\n"),
    );
    assert.ok(p.rewrite !== null && !p.rewrite.includes("ProtectHome"));
    assert.deepEqual(p.customised?.missing, ["ProtectHome=yes"]);
  });

  it("reads back the installed binary, port and host", () => {
    const bin = "/opt/node/bin/volute";
    const p = plan(generateSystemUnit(bin, 4242, "127.0.0.1"));
    assert.equal(p.customised, null);
    assert.equal(plan(generateSystemUnit(BIN)).customised, null);
  });

  it("leaves a unit it cannot read back alone", () => {
    for (const execStart of [
      "ExecStart=/usr/bin/node /opt/volute/cli.js up --foreground",
      `ExecStart=-${BIN} up --foreground`,
      `ExecStart=@${BIN} up --foreground`,
      `ExecStart=+${BIN} up --foreground`,
      `ExecStart=!${BIN} up --foreground`,
      `ExecStart="/opt/my volute/volute" up --foreground`,
      `ExecStart=volute up --foreground`,
      `ExecStart=${BIN} up --port 1618`,
      `ExecStart=${BIN} up --foreground --port abc`,
      `ExecStart=${BIN} up --foreground --port`,
      `ExecStart=${BIN} up --foreground --verbose yes`,
    ]) {
      const unit = current.replace(/^ExecStart=.*$/m, execStart);
      assert.deepEqual(planServiceFile("systemd", unit), { status: "unrecognised" }, execStart);
    }
    assert.deepEqual(planServiceFile("systemd", "[Unit]\n"), { status: "unrecognised" });
  });
});

describe("planServiceFile (launchd)", () => {
  const current = generateSystemPlist(BIN, { port: 1618, host: "0.0.0.0" });

  it("leaves a plist this version wrote alone", () => {
    assert.deepEqual(planServiceFile("launchd", current), {
      status: "reviewed",
      rewrite: null,
      migrated: [],
      customised: null,
    });
  });

  it("reports a changed plist without rewriting it", () => {
    const old = current.replace(
      "<key>KeepAlive</key>\n  <true/>",
      "<key>KeepAlive</key>\n  <false/>",
    );
    const p = planServiceFile("launchd", old);
    assert.equal(p.status, "reviewed");
    if (p.status !== "reviewed") return;
    assert.equal(p.rewrite, null);
    assert.deepEqual(p.customised?.extra, ["  <false/>"]);
  });

  it("unescapes XML in the binary path", () => {
    const plist = generateSystemPlist("/opt/a&b/volute", { host: "0.0.0.0" });
    const p = planServiceFile("launchd", plist);
    assert.equal(p.status === "reviewed" && p.customised, null);
  });

  it("leaves a plist without volute's program arguments alone", () => {
    assert.deepEqual(planServiceFile("launchd", "<plist></plist>"), { status: "unrecognised" });
  });
});

describe("prefixWritable", () => {
  it("is true only for a prefix whose lib/node_modules this user can write", () => {
    const prefix = mkdtempSync(resolve(tmpdir(), "volute-prefix-"));
    const install = (p: string | null) => ({ prefix: p }) as unknown as VoluteInstall;
    assert.equal(prefixWritable(install(prefix)), false, "no lib/node_modules yet");
    const modules = resolve(prefix, "lib", "node_modules");
    mkdirSync(modules, { recursive: true });
    assert.equal(prefixWritable(install(prefix)), true);
    assert.equal(prefixWritable(install(null)), false);
    assert.equal(prefixWritable(null), false);
    if (process.getuid?.() !== 0) {
      chmodSync(modules, 0o555);
      assert.equal(prefixWritable(install(prefix)), false);
      chmodSync(modules, 0o755);
    }
  });
});

describe("readServiceFile", () => {
  it("reports an unreadable file rather than treating it as absent", (t) => {
    if (process.getuid?.() === 0) return t.skip("root reads through file modes");
    const dir = mkdtempSync(resolve(tmpdir(), "volute-unit-"));
    const path = resolve(dir, "volute.service");
    assert.equal(readServiceFile("systemd", path), null);
    writeFileSync(path, "[Unit]\n");
    assert.deepEqual(readServiceFile("systemd", path), {
      kind: "systemd",
      path,
      text: "[Unit]\n",
    });
    chmodSync(path, 0o000);
    const found = readServiceFile("systemd", path);
    assert.ok(found && "unreadable" in found);
  });
});
