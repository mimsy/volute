import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  type BridgeDef,
  checkMissingBridgeEnv,
  getBridgeDef,
} from "../packages/daemon/src/lib/bridge-defs.js";

describe("bridge-defs", () => {
  describe("getBridgeDef", () => {
    it("returns def for discord", () => {
      const def = getBridgeDef("discord");
      assert.ok(def);
      assert.equal(def.displayName, "Discord");
      assert.ok(def.envVars.some((v) => v.name === "DISCORD_TOKEN" && v.required));
    });

    it("returns def for slack", () => {
      const def = getBridgeDef("slack");
      assert.ok(def);
      assert.equal(def.displayName, "Slack");
      assert.ok(def.envVars.some((v) => v.name === "SLACK_BOT_TOKEN" && v.required));
      assert.ok(def.envVars.some((v) => v.name === "SLACK_APP_TOKEN" && v.required));
    });

    it("returns def for telegram", () => {
      const def = getBridgeDef("telegram");
      assert.ok(def);
      assert.equal(def.displayName, "Telegram");
      assert.ok(def.envVars.some((v) => v.name === "TELEGRAM_BOT_TOKEN" && v.required));
    });

    it("returns null for unknown type", () => {
      assert.equal(getBridgeDef("unknown"), null);
    });

    let tmpDir: string;

    beforeEach(() => {
      tmpDir = join(tmpdir(), `bridge-defs-test-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("loads bridge.json from custom bridge dir", () => {
      const customDef: BridgeDef = {
        displayName: "Custom",
        description: "A custom bridge",
        envVars: [{ name: "CUSTOM_TOKEN", required: true, description: "Custom token" }],
      };
      writeFileSync(join(tmpDir, "bridge.json"), JSON.stringify(customDef));
      const def = getBridgeDef("custom", tmpDir);
      assert.ok(def);
      assert.equal(def.displayName, "Custom");
    });
  });

  describe("checkMissingBridgeEnv", () => {
    it("returns empty when all required present", () => {
      const def: BridgeDef = {
        displayName: "Test",
        description: "test",
        envVars: [
          { name: "FOO", required: true, description: "foo" },
          { name: "BAR", required: false, description: "bar" },
        ],
      };
      assert.equal(checkMissingBridgeEnv(def, { FOO: "val" }).length, 0);
    });

    it("returns missing required vars", () => {
      const def: BridgeDef = {
        displayName: "Test",
        description: "test",
        envVars: [
          { name: "FOO", required: true, description: "foo" },
          { name: "BAR", required: true, description: "bar" },
        ],
      };
      const missing = checkMissingBridgeEnv(def, { BAR: "val" });
      assert.equal(missing.length, 1);
      assert.equal(missing[0].name, "FOO");
    });
  });
});
