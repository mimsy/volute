import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  type ConnectorDef,
  checkMissingEnvVars,
  getConnectorDef,
} from "@volute/shared/connector-defs";

describe("connector-defs", () => {
  describe("getConnectorDef", () => {
    it("returns def for discord", () => {
      const def = getConnectorDef("discord");
      assert.ok(def);
      assert.equal(def.displayName, "Discord");
      assert.ok(def.envVars.some((v) => v.name === "DISCORD_TOKEN" && v.required));
    });

    it("returns def for slack", () => {
      const def = getConnectorDef("slack");
      assert.ok(def);
      assert.equal(def.displayName, "Slack");
      assert.ok(def.envVars.some((v) => v.name === "SLACK_BOT_TOKEN" && v.required));
      assert.ok(def.envVars.some((v) => v.name === "SLACK_APP_TOKEN" && v.required));
    });

    it("returns def for telegram", () => {
      const def = getConnectorDef("telegram");
      assert.ok(def);
      assert.equal(def.displayName, "Telegram");
      assert.ok(def.envVars.some((v) => v.name === "TELEGRAM_BOT_TOKEN" && v.required));
    });

    it("returns null for unknown type without connector dir", () => {
      const def = getConnectorDef("unknown");
      assert.equal(def, null);
    });

    let tmpDir: string;

    beforeEach(() => {
      tmpDir = join(tmpdir(), `connector-defs-test-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("loads connector.json from custom connector dir", () => {
      const customDef: ConnectorDef = {
        displayName: "Custom",
        description: "A custom connector",
        envVars: [
          { name: "CUSTOM_TOKEN", required: true, description: "Custom token", scope: "mind" },
        ],
      };
      writeFileSync(join(tmpDir, "connector.json"), JSON.stringify(customDef));
      const def = getConnectorDef("custom", tmpDir);
      assert.ok(def);
      assert.equal(def.displayName, "Custom");
      assert.equal(def.envVars.length, 1);
      assert.equal(def.envVars[0].name, "CUSTOM_TOKEN");
    });

    it("returns null for unknown type with no connector.json", () => {
      const def = getConnectorDef("custom", tmpDir);
      assert.equal(def, null);
    });

    it("returns null when connector.json is malformed", () => {
      writeFileSync(join(tmpDir, "connector.json"), "not valid json{{{");
      const def = getConnectorDef("custom", tmpDir);
      assert.equal(def, null);
    });
  });

  describe("checkMissingEnvVars", () => {
    it("returns empty array when all required vars present", () => {
      const def: ConnectorDef = {
        displayName: "Test",
        description: "test",
        envVars: [
          { name: "FOO", required: true, description: "foo", scope: "mind" },
          { name: "BAR", required: false, description: "bar", scope: "any" },
        ],
      };
      const missing = checkMissingEnvVars(def, { FOO: "value" });
      assert.equal(missing.length, 0);
    });

    it("returns missing required vars", () => {
      const def: ConnectorDef = {
        displayName: "Test",
        description: "test",
        envVars: [
          { name: "FOO", required: true, description: "foo", scope: "mind" },
          { name: "BAR", required: true, description: "bar", scope: "mind" },
          { name: "BAZ", required: false, description: "baz", scope: "any" },
        ],
      };
      const missing = checkMissingEnvVars(def, { BAR: "value" });
      assert.equal(missing.length, 1);
      assert.equal(missing[0].name, "FOO");
    });

    it("returns all missing when env is empty", () => {
      const def: ConnectorDef = {
        displayName: "Test",
        description: "test",
        envVars: [
          { name: "A", required: true, description: "a", scope: "mind" },
          { name: "B", required: true, description: "b", scope: "mind" },
        ],
      };
      const missing = checkMissingEnvVars(def, {});
      assert.equal(missing.length, 2);
    });

    it("treats empty string values as missing", () => {
      const def: ConnectorDef = {
        displayName: "Test",
        description: "test",
        envVars: [{ name: "TOKEN", required: true, description: "token", scope: "mind" }],
      };
      const missing = checkMissingEnvVars(def, { TOKEN: "" });
      assert.equal(missing.length, 1);
    });
  });
});
