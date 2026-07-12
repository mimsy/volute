import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { detectSystemInstallHint } from "../packages/cli/src/lib/system-install.js";

describe("detectSystemInstallHint", () => {
  const originalHome = process.env.VOLUTE_HOME;
  afterEach(() => {
    if (originalHome === undefined) delete process.env.VOLUTE_HOME;
    else process.env.VOLUTE_HOME = originalHome;
  });

  it("returns the hint when a systemd service is installed and VOLUTE_HOME is unset", () => {
    const hint = detectSystemInstallHint({
      hasSystemd: true,
      hasLaunchd: false,
      voluteHomeSet: false,
    });
    assert.ok(hint);
    assert.match(hint, /VOLUTE_HOME is not set/);
    assert.match(hint, /export VOLUTE_HOME=\/var\/lib\/volute/);
    // systemd installs get the profile.d guidance
    assert.match(hint, /source \/etc\/profile\.d\/volute\.sh/);
  });

  it("returns the hint for a macOS LaunchDaemon without profile.d guidance", () => {
    const hint = detectSystemInstallHint({
      hasSystemd: false,
      hasLaunchd: true,
      voluteHomeSet: false,
    });
    assert.ok(hint);
    assert.match(hint, /export VOLUTE_HOME=\/var\/lib\/volute/);
    // no systemd → no profile.d line
    assert.doesNotMatch(hint, /profile\.d/);
  });

  it("returns null when no system service is installed", () => {
    assert.equal(
      detectSystemInstallHint({ hasSystemd: false, hasLaunchd: false, voluteHomeSet: false }),
      null,
    );
  });

  it("returns null when VOLUTE_HOME is already set, even with a service present", () => {
    assert.equal(
      detectSystemInstallHint({ hasSystemd: true, hasLaunchd: true, voluteHomeSet: true }),
      null,
    );
  });

  it("reads process.env.VOLUTE_HOME by default", () => {
    process.env.VOLUTE_HOME = "/var/lib/volute";
    assert.equal(detectSystemInstallHint({ hasSystemd: true, hasLaunchd: false }), null);
  });
});
