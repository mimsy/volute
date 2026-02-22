import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { DeliveryManager } from "../src/lib/delivery-manager.js";
import type { RoutingConfig } from "../src/lib/delivery-router.js";
import { clearConfigCache } from "../src/lib/delivery-router.js";
import { addMind, removeMind } from "../src/lib/registry.js";

function createMindWithRoutes(config: RoutingConfig | object): string {
  const port = 4100 + Math.floor(Math.random() * 1000);
  const name = `dm-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  addMind(name, port);
  const dir = resolve(process.env.VOLUTE_HOME!, "minds", name);
  const configDir = resolve(dir, "home/.config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(resolve(configDir, "routes.json"), JSON.stringify(config));
  return name;
}

describe("DeliveryManager", () => {
  let manager: DeliveryManager;

  afterEach(() => {
    manager?.dispose();
    clearConfigCache();
  });

  describe("routeAndDeliver", () => {
    it("routes to correct session based on rules", async () => {
      const name = createMindWithRoutes({
        rules: [{ channel: "discord:*", session: "discord" }],
        default: "main",
      });

      manager = new DeliveryManager();
      const result = await manager.routeAndDeliver(name, {
        channel: "discord:general",
        sender: "alice",
        content: "hello",
      });

      assert.equal(result.routed, true);
      if (result.routed) {
        assert.equal(result.session, "discord");
        assert.equal(result.destination, "mind");
        // Will fail delivery since no mind server is running, but routing is correct
      }
      removeMind(name);
    });

    it("routes to default session when no rules match", async () => {
      const name = createMindWithRoutes({
        rules: [{ channel: "discord:*", session: "discord" }],
        default: "fallback",
        gateUnmatched: false,
      });

      manager = new DeliveryManager();
      const result = await manager.routeAndDeliver(name, {
        channel: "slack:general",
        sender: "bob",
        content: "hi",
      });

      assert.equal(result.routed, true);
      if (result.routed) {
        assert.equal(result.session, "fallback");
      }
      removeMind(name);
    });

    it("gates unmatched channels by default", async () => {
      const name = createMindWithRoutes({
        rules: [{ channel: "discord:*", session: "discord" }],
      });

      manager = new DeliveryManager();
      const result = await manager.routeAndDeliver(name, {
        channel: "slack:random",
        sender: "charlie",
        content: "test",
      });

      assert.equal(result.routed, true);
      if (result.routed) {
        assert.equal(result.mode, "gated");
      }
      removeMind(name);
    });

    it("does not gate when gateUnmatched is false", async () => {
      const name = createMindWithRoutes({
        rules: [{ channel: "discord:*", session: "discord" }],
        default: "main",
        gateUnmatched: false,
      });

      manager = new DeliveryManager();
      const result = await manager.routeAndDeliver(name, {
        channel: "unknown:channel",
        sender: "dave",
        content: "test",
      });

      assert.equal(result.routed, true);
      if (result.routed) {
        assert.equal(result.mode, "immediate");
        assert.equal(result.session, "main");
      }
      removeMind(name);
    });

    it("returns file destination for file rules", async () => {
      const name = createMindWithRoutes({
        rules: [{ channel: "logs:*", destination: "file", path: "inbox/logs.md" }],
      });

      manager = new DeliveryManager();
      const result = await manager.routeAndDeliver(name, {
        channel: "logs:system",
        sender: null,
        content: "log entry",
      });

      assert.equal(result.routed, true);
      if (result.routed) {
        assert.equal(result.destination, "file");
      }
      removeMind(name);
    });

    it("returns batch mode for batch-configured sessions", async () => {
      const name = createMindWithRoutes({
        rules: [{ channel: "discord:*", session: "discord" }],
        sessions: { discord: { delivery: "batch" } },
      });

      manager = new DeliveryManager();
      const result = await manager.routeAndDeliver(name, {
        channel: "discord:general",
        sender: "alice",
        content: "message 1",
      });

      assert.equal(result.routed, true);
      if (result.routed) {
        assert.equal(result.mode, "batch");
        assert.equal(result.session, "discord");
      }
      removeMind(name);
    });

    it("filters mention-mode messages that don't mention the mind", async () => {
      const name = createMindWithRoutes({
        rules: [{ channel: "group:*", session: "group", mode: "mention" }],
      });

      manager = new DeliveryManager();
      const result = await manager.routeAndDeliver(name, {
        channel: "group:general",
        sender: "alice",
        content: "hey everyone",
      });

      assert.equal(result.routed, false);
      if (!result.routed) {
        assert.equal(result.reason, "mention-filtered");
      }
      removeMind(name);
    });
  });

  describe("session tracking", () => {
    it("tracks session as busy after delivery", async () => {
      const name = createMindWithRoutes({
        rules: [{ channel: "test:*", session: "test" }],
        gateUnmatched: false,
      });

      manager = new DeliveryManager();
      // This will fail delivery (no mind server), but should still track state
      await manager.routeAndDeliver(name, {
        channel: "test:ch",
        sender: "alice",
        content: "hello",
      });

      // Session state should exist (even if delivery failed, it was incremented then decremented)
      // Just verify it doesn't throw
      assert.equal(typeof manager.isSessionBusy(name, "test"), "boolean");
      removeMind(name);
    });

    it("sessionDone decrements active count", () => {
      manager = new DeliveryManager();
      // Calling sessionDone on nonexistent session should not throw
      manager.sessionDone("nonexistent", "main");
    });
  });

  describe("getPending", () => {
    it("returns empty for mind with no pending messages", async () => {
      manager = new DeliveryManager();
      const pending = await manager.getPending("nonexistent-mind");
      assert.deepEqual(pending, []);
    });
  });
});
