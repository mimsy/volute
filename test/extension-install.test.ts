import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  installNpmExtension,
  uninstallNpmExtension,
} from "../packages/daemon/src/lib/extensions.js";

// Verifies `volute extension install` shells out to npm with --ignore-scripts,
// so untrusted package lifecycle scripts never run as the daemon user.
describe("installNpmExtension", () => {
  let fakeBinDir: string;
  let argvLog: string;
  let prevPath: string | undefined;

  beforeEach(() => {
    fakeBinDir = mkdtempSync(resolve(tmpdir(), "volute-fake-npm-"));
    argvLog = resolve(fakeBinDir, "argv.log");
    // A stub `npm` that records its argv and exits 0 without doing anything.
    const npmPath = resolve(fakeBinDir, "npm");
    writeFileSync(npmPath, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvLog}"\nexit 0\n`);
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
});
