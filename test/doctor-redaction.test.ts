import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  looksLikeSecretString,
  REDACTED,
  redactConfigJson,
  redactEnvJson,
  redactLogText,
  redactValue,
} from "../packages/daemon/src/lib/doctor.js";

/**
 * The `volute doctor --bundle` tarball is attached to bug reports, so its whole
 * reason for existing is that it leaks NO secrets. These tests are the critical
 * path: a real API key, OAuth token, or env value must never survive redaction.
 */
describe("doctor redaction", () => {
  describe("redactValue", () => {
    it("redacts values under secret-looking keys, keeps the key names", () => {
      const out = redactValue({
        apiKey: "sk-ant-abc123",
        access_token: "xoxb-9999",
        refreshToken: "rt-secret",
        password: "hunter2",
        client_secret: "cs-live-xyz",
      }) as Record<string, unknown>;
      assert.equal(out.apiKey, REDACTED);
      assert.equal(out.access_token, REDACTED);
      assert.equal(out.refreshToken, REDACTED);
      assert.equal(out.password, REDACTED);
      assert.equal(out.client_secret, REDACTED);
    });

    it("keeps non-secret fields untouched", () => {
      const out = redactValue({
        name: "myserver",
        port: 1618,
        setup: { isolation: "sandbox", type: "system" },
        models: ["claude-opus-4-8"],
      });
      assert.deepEqual(out, {
        name: "myserver",
        port: 1618,
        setup: { isolation: "sandbox", type: "system" },
        models: ["claude-opus-4-8"],
      });
    });

    it("preserves provider NAMES but redacts their credentials", () => {
      const out = redactValue({
        ai: {
          providers: {
            anthropic: { apiKey: "sk-ant-topsecret" },
            openai: { oauth: { refresh: "r", access: "a", expires: 1 } },
          },
        },
      }) as { ai: { providers: Record<string, unknown> } };
      // Names visible (useful for "provider config present")...
      assert.deepEqual(Object.keys(out.ai.providers).sort(), ["anthropic", "openai"]);
      // ...but no credential material.
      assert.equal((out.ai.providers.anthropic as Record<string, unknown>).apiKey, REDACTED);
      assert.deepEqual(out.ai.providers.openai, { oauth: REDACTED });
      assert.ok(!JSON.stringify(out).includes("sk-ant-topsecret"));
    });

    it("masks every value of an env-shaped map regardless of key name", () => {
      const out = redactValue({
        env: { AWS_ACCESS_KEY_ID: "AKIA...", INNOCENT_LOOKING: "still-a-secret" },
      }) as { env: Record<string, unknown> };
      assert.equal(out.env.AWS_ACCESS_KEY_ID, REDACTED);
      assert.equal(out.env.INNOCENT_LOOKING, REDACTED);
    });

    it("redacts credential-shaped string values under innocuous keys", () => {
      const out = redactValue({ note: "sk-ant-api03-abcdef", greeting: "hello world" }) as Record<
        string,
        unknown
      >;
      assert.equal(out.note, REDACTED);
      assert.equal(out.greeting, "hello world");
    });
  });

  describe("looksLikeSecretString", () => {
    it("flags known token shapes", () => {
      for (const s of [
        "sk-ant-api03-xxxx",
        "vmt_abcdef123456",
        "xoxb-123-456",
        "ghp_abcdefghij",
        "Bearer abc.def",
        "-----BEGIN PRIVATE KEY-----",
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
        "a".repeat(48),
      ]) {
        assert.ok(looksLikeSecretString(s), `expected secret: ${s}`);
      }
    });

    it("does not flag ordinary short strings", () => {
      for (const s of ["sandbox", "127.0.0.1", "claude-opus-4-8", "hello world", "1618"]) {
        assert.ok(!looksLikeSecretString(s), `unexpected secret: ${s}`);
      }
    });
  });

  describe("redactLogText", () => {
    it("masks credential values in key=value / key: value pairs, keeps the key", () => {
      const out = redactLogText(
        "connecting token=abc123secret\nAPI_KEY: sk-livexxxx\npassword=hunter2 done",
      );
      assert.ok(/token=\[REDACTED\]/.test(out));
      assert.ok(/API_KEY: \[REDACTED\]/.test(out));
      assert.ok(/password=\[REDACTED\]/.test(out));
      assert.ok(!out.includes("abc123secret"));
      assert.ok(!out.includes("hunter2"));
      // Surrounding log text is preserved.
      assert.ok(out.includes("connecting"));
      assert.ok(out.includes("done"));
    });

    it("masks Bearer tokens and standalone token shapes anywhere in a line", () => {
      const out = redactLogText(
        "GET /x Authorization: Bearer eyJhbGciOiJ.payload.sig\nmint vmt_abcdef123456 for alice\nkey sk-ant-api03-LEAKED here",
      );
      assert.ok(!out.includes("eyJhbGciOiJ.payload.sig"));
      assert.ok(!out.includes("vmt_abcdef123456"));
      assert.ok(!out.includes("sk-ant-api03-LEAKED"));
      assert.ok(out.includes("for alice"));
    });

    it("leaves ordinary log lines untouched", () => {
      const line = "2026-07-23 10:00:00 mind alice started on port 4100";
      assert.equal(redactLogText(line), line);
    });
  });

  describe("redactEnvJson", () => {
    it("masks all values, keeps keys", () => {
      const out = redactEnvJson(
        JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant-xxx", MY_FLAG: "true", PORT: "9000" }),
      );
      const parsed = JSON.parse(out);
      assert.deepEqual(parsed, {
        ANTHROPIC_API_KEY: REDACTED,
        MY_FLAG: REDACTED,
        PORT: REDACTED,
      });
      assert.ok(!out.includes("sk-ant-xxx"));
      assert.ok(!out.includes("true"));
    });

    it("drops the file entirely when it can't be parsed", () => {
      const out = redactEnvJson("{ this is not: json");
      assert.ok(out.includes("could not be parsed"));
      assert.ok(!out.includes("json}"));
    });
  });

  describe("redactConfigJson — no secret survives", () => {
    // A config with a secret planted in every place one could plausibly live.
    const SECRETS = [
      "sk-ant-api03-REALKEY",
      "oauth-refresh-REALTOKEN",
      "oauth-access-REALTOKEN",
      "restic-passphrase-REAL",
      "AKIAIOSFODNN7EXAMPLE",
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "vmt_realminttoken",
    ];
    const config = {
      name: "server",
      port: 1618,
      setup: { isolation: "sandbox", type: "system" },
      ai: {
        providers: {
          anthropic: { apiKey: "sk-ant-api03-REALKEY" },
          openai: {
            oauth: { refresh: "oauth-refresh-REALTOKEN", access: "oauth-access-REALTOKEN" },
          },
        },
        models: ["claude-opus-4-8"],
      },
      backup: {
        repository: "s3:example",
        password: "restic-passphrase-REAL",
        env: {
          AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
          AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        },
      },
      someToken: "vmt_realminttoken",
    };

    it("contains none of the planted secret values", () => {
      const out = redactConfigJson(JSON.stringify(config));
      for (const secret of SECRETS) {
        assert.ok(!out.includes(secret), `leaked secret: ${secret}`);
      }
    });

    it("keeps non-secret operational fields for diagnosis", () => {
      const out = redactConfigJson(JSON.stringify(config));
      const parsed = JSON.parse(out);
      assert.equal(parsed.name, "server");
      assert.equal(parsed.port, 1618);
      assert.equal(parsed.setup.isolation, "sandbox");
      assert.deepEqual(parsed.ai.models, ["claude-opus-4-8"]);
      assert.deepEqual(Object.keys(parsed.ai.providers).sort(), ["anthropic", "openai"]);
      assert.equal(parsed.backup.repository, "s3:example");
    });

    it("drops the file entirely when it can't be parsed", () => {
      const out = redactConfigJson("not json at all");
      assert.ok(out.includes("could not be parsed"));
    });
  });
});
