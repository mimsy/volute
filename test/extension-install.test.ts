import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  installNpmExtension,
  uninstallNpmExtension,
} from "../packages/daemon/src/lib/extensions.js";
import { voluteSystemDir } from "../packages/daemon/src/lib/mind/registry.js";

// Verifies `volute extension install` shells out to npm with --ignore-scripts,
// so untrusted package lifecycle scripts never run as the daemon user.
describe("installNpmExtension", () => {
  let fakeBinDir: string;
  let argvLog: string;
  let cacheLog: string;
  let prevPath: string | undefined;

  beforeEach(() => {
    fakeBinDir = mkdtempSync(resolve(tmpdir(), "volute-fake-npm-"));
    argvLog = resolve(fakeBinDir, "argv.log");
    cacheLog = resolve(fakeBinDir, "cache.log");
    // A stub `npm` that records its argv and cache dir and exits 0 without doing anything.
    const npmPath = resolve(fakeBinDir, "npm");
    writeFileSync(
      npmPath,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvLog}"\nprintf '%s' "$npm_config_cache" > "${cacheLog}"\nexit 0\n`,
    );
    chmodSync(npmPath, 0o755);
    prevPath = process.env.PATH;
    process.env.PATH = `${fakeBinDir}:${process.env.PATH ?? ""}`;
  });

  afterEach(() => {
    process.env.PATH = prevPath;
  });

  it("passes --ignore-scripts to npm install", async () => {
    await installNpmExtension("testpkg");
    const argv = readFileSync(argvLog, "utf-8").split("\n").filter(Boolean);
    assert.deepEqual(argv, ["install", "--ignore-scripts", "testpkg"]);
  });

  it("passes --ignore-scripts to npm uninstall", async () => {
    // Must be installed first (uninstall throws otherwise). The install call
    // overwrites argv.log; the uninstall call overwrites it again with its argv.
    await installNpmExtension("uninstallpkg");
    await uninstallNpmExtension("uninstallpkg");
    const argv = readFileSync(argvLog, "utf-8").split("\n").filter(Boolean);
    assert.deepEqual(argv, ["uninstall", "--ignore-scripts", "uninstallpkg"]);
  });

  // #1223: under the system unit's ProtectHome=yes the daemon's HOME is unreachable,
  // so npm's default ~/.npm cache fails; host installs cache under the system dir.
  it("points npm's cache under the system dir for install and uninstall", async () => {
    const expected = resolve(voluteSystemDir(), ".npm-cache");
    await installNpmExtension("cachepkg");
    assert.equal(readFileSync(cacheLog, "utf-8"), expected);
    await uninstallNpmExtension("cachepkg");
    assert.equal(readFileSync(cacheLog, "utf-8"), expected);
  });
});
