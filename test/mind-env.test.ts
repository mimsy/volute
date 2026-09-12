import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildMindBaseEnv } from "../packages/daemon/src/lib/util/mind-env.js";

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

  it("carries XDG_CONFIG_HOME but no npm credential var (#966)", () => {
    // Both halves are one decision. git and npm must still find a host's config when
    // it lives off ~/.config, so the directory is allowlisted. The npm *credential*
    // vars are not, and must not be: a mind's own postinstall script would read them,
    // which is the leak this change closes rather than an exception to it.
    const env = buildMindBaseEnv({
      XDG_CONFIG_HOME: "/etc/xdg-config",
      NODE_AUTH_TOKEN: "npm-publish-secret",
      NPM_CONFIG__AUTH: "basic-auth-secret",
      npm_config__authToken: "registry-secret",
    });
    assert.equal(env.XDG_CONFIG_HOME, "/etc/xdg-config");
    assert.equal(env.NODE_AUTH_TOKEN, undefined);
    assert.equal(env.NPM_CONFIG__AUTH, undefined);
    assert.equal(env.npm_config__authToken, undefined);
  });

  it("passes through outbound proxy / custom-CA vars", () => {
    const env = buildMindBaseEnv({
      HTTP_PROXY: "http://proxy:8080",
      HTTPS_PROXY: "http://proxy:8080",
      NO_PROXY: "localhost,127.0.0.1",
      http_proxy: "http://proxy:8080",
      https_proxy: "http://proxy:8080",
      no_proxy: "localhost,127.0.0.1",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/corp-ca.pem",
      SSL_CERT_FILE: "/etc/ssl/cert.pem",
      SSL_CERT_DIR: "/etc/ssl/certs",
      // A secret alongside them must still be withheld.
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      GITHUB_TOKEN: "gh-secret",
      VOLUTE_DAEMON_TOKEN: "admin-secret",
    });
    assert.equal(env.HTTP_PROXY, "http://proxy:8080");
    assert.equal(env.HTTPS_PROXY, "http://proxy:8080");
    assert.equal(env.NO_PROXY, "localhost,127.0.0.1");
    assert.equal(env.http_proxy, "http://proxy:8080");
    assert.equal(env.https_proxy, "http://proxy:8080");
    assert.equal(env.no_proxy, "localhost,127.0.0.1");
    assert.equal(env.NODE_EXTRA_CA_CERTS, "/etc/ssl/corp-ca.pem");
    assert.equal(env.SSL_CERT_FILE, "/etc/ssl/cert.pem");
    assert.equal(env.SSL_CERT_DIR, "/etc/ssl/certs");
    // Secrets remain withheld even in a proxied environment.
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.VOLUTE_DAEMON_TOKEN, undefined);
  });

  it("omits allowlisted vars that are unset in the source", () => {
    const env = buildMindBaseEnv({ PATH: "/usr/bin" });
    assert.ok(!("HOME" in env));
    assert.ok(!("TERM" in env));
  });
});
