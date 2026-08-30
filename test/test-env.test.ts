import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { stripInheritedVoluteEnv, TEST_ENV_KEEP } from "./helpers/test-env.js";

describe("stripInheritedVoluteEnv", () => {
  it("removes inherited VOLUTE_* vars, keeping the documented per-run knobs", () => {
    const env: NodeJS.ProcessEnv = {
      VOLUTE_MINDS_DIR: "/minds",
      VOLUTE_HOME: "/var/lib/volute",
      VOLUTE_MIND: "mimsy",
      VOLUTE_UPGRADE_FROM: "0.56.0",
      PATH: "/usr/bin",
    };

    const stripped = stripInheritedVoluteEnv(env);

    assert.deepEqual(stripped.sort(), ["VOLUTE_HOME", "VOLUTE_MINDS_DIR", "VOLUTE_MIND"].sort());
    assert.equal(env.VOLUTE_MINDS_DIR, undefined);
    assert.equal(env.VOLUTE_UPGRADE_FROM, "0.56.0", "a knob a test run was given must survive");
    assert.equal(env.PATH, "/usr/bin", "non-VOLUTE vars are untouched");
  });

  it("keeps every documented knob", () => {
    const env: NodeJS.ProcessEnv = Object.fromEntries([...TEST_ENV_KEEP].map((k) => [k, "v"]));
    assert.deepEqual(stripInheritedVoluteEnv(env), []);
  });
});

describe("test harness environment", () => {
  /**
   * The 1.6G regression (#805): a mind's own env carries VOLUTE_MINDS_DIR=/minds
   * on a production host, and backupRoots() reads it straight from process.env —
   * so an unstripped one pointed the restic round-trip test at every real mind on
   * the box, and copied them into the test scratch dir.
   *
   * Asserting on this process's env would prove nothing in CI, where no VOLUTE_*
   * var is set to begin with and the assertion passes whether or not the strip
   * exists. So the check runs in a child that is deliberately poisoned with the
   * bardo environment, and reports what setup.ts left it holding.
   */
  it("strips a poisoned VOLUTE_MINDS_DIR before any test can read it", async () => {
    const report =
      "import('node:fs').then(() => {" +
      "process.stdout.write(JSON.stringify({" +
      "mindsDir: process.env.VOLUTE_MINDS_DIR ?? null," +
      "mind: process.env.VOLUTE_MIND ?? null," +
      "home: process.env.VOLUTE_HOME ?? null," +
      "}));" +
      "})";

    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "--import", "./test/setup.ts", "-e", report],
      {
        cwd: resolve(import.meta.dirname, ".."),
        env: {
          ...process.env,
          VOLUTE_MINDS_DIR: "/minds",
          VOLUTE_MIND: "mimsy",
          VOLUTE_HOME: "/var/lib/volute",
        },
        timeout: 60_000,
      },
    );
    const seen = JSON.parse(stdout) as {
      mindsDir: string | null;
      mind: string | null;
      home: string;
    };

    assert.equal(seen.mindsDir, null, "backupRoots() would have walked the real /minds");
    assert.equal(seen.mind, null, "an inherited mind identity must not steer a test run");
    assert.notEqual(seen.home, "/var/lib/volute", "setup.ts must install its own VOLUTE_HOME");
    assert.match(seen.home, /volute-test-\d+$/, "and it must be this run's own test home");
  });

  it("keeps a documented per-run knob the host passed in", async () => {
    const report = "process.stdout.write(process.env.VOLUTE_UPGRADE_FROM ?? '')";
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "--import", "./test/setup.ts", "-e", report],
      {
        cwd: resolve(import.meta.dirname, ".."),
        env: { ...process.env, VOLUTE_UPGRADE_FROM: "0.56.0" },
        timeout: 60_000,
      },
    );
    assert.equal(stdout, "0.56.0", "npm run test:upgrade must still honour its knob");
  });
});
