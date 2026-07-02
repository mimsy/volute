import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildMindBaseEnv } from "../packages/daemon/src/lib/daemon/mind-manager.js";

describe("buildMindBaseEnv", () => {
  it("withholds the daemon admin token", () => {
    const env = buildMindBaseEnv({
      VOLUTE_DAEMON_TOKEN: "admin-secret",
      VOLUTE_DAEMON_PORT: "1618",
    });
    assert.equal(env.VOLUTE_DAEMON_TOKEN, undefined);
    // Ensure the admin secret value doesn't leak under any key.
    assert.ok(!Object.values(env).includes("admin-secret"));
  });

  it("withholds ambient host secrets (allowlist, not full spread)", () => {
    const env = buildMindBaseEnv({
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      GITHUB_TOKEN: "gh-secret",
      OPENAI_API_KEY: "sk-secret",
      PATH: "/usr/bin",
    });
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    // Provider keys are injected explicitly by the manager from config, not inherited.
    assert.equal(env.OPENAI_API_KEY, undefined);
  });

  it("passes through benign system vars and VOLUTE_* vars", () => {
    const env = buildMindBaseEnv({
      PATH: "/usr/bin",
      HOME: "/home/mind",
      LANG: "en_US.UTF-8",
      TERM: "xterm",
      VOLUTE_DAEMON_PORT: "1618",
      VOLUTE_HOME: "/data",
      VOLUTE_ISOLATION: "user",
    });
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.HOME, "/home/mind");
    assert.equal(env.LANG, "en_US.UTF-8");
    assert.equal(env.TERM, "xterm");
    assert.equal(env.VOLUTE_DAEMON_PORT, "1618");
    assert.equal(env.VOLUTE_HOME, "/data");
    assert.equal(env.VOLUTE_ISOLATION, "user");
  });

  it("omits allowlisted vars that are unset in the source", () => {
    const env = buildMindBaseEnv({ PATH: "/usr/bin" });
    assert.ok(!("HOME" in env));
    assert.ok(!("TERM" in env));
  });
});
