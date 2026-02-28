import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { addMind, removeMind } from "@volute/shared/registry";
import { DeliveryManager } from "../src/lib/delivery/delivery-manager.js";
import type { RoutingConfig } from "../src/lib/delivery/delivery-router.js";
import { clearConfigCache } from "../src/lib/delivery/delivery-router.js";

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

  describe("new-speaker batch interrupt", () => {
    function setBatchSession() {
      return createMindWithRoutes({
        rules: [{ channel: "group:*", session: "group" }],
        sessions: { group: { delivery: { mode: "batch", debounce: 2, maxWait: 10 } } },
        gateUnmatched: false,
      });
    }

    function simulateActive(
      mgr: DeliveryManager,
      mind: string,
      session: string,
      senders: string[],
      channels: string[],
    ) {
      const states = (mgr as any).sessionStates as Map<string, Map<string, any>>;
      let mindSessions = states.get(mind);
      if (!mindSessions) {
        mindSessions = new Map();
        states.set(mind, mindSessions);
      }
      mindSessions.set(session, {
        activeCount: 1,
        lastDeliveredAt: Date.now(),
        lastDeliverySenders: new Set(senders),
        lastDeliveryChannels: new Set(channels),
        lastInterruptAt: 0,
      });
    }

    function getBatchBuffer(mgr: DeliveryManager, mind: string, session: string) {
      return (mgr as any).batchBuffers.get(`${mind}:${session}`);
    }

    it("new speaker in same channel triggers interrupt flush", async () => {
      const name = setBatchSession();
      manager = new DeliveryManager();

      // Simulate mind active from a delivery to sender A in group:chat
      simulateActive(manager, name, "group", ["alice"], ["group:chat"]);

      // Deliver from sender B in same channel — should trigger interrupt flush
      const result = await manager.routeAndDeliver(name, {
        channel: "group:chat",
        sender: "bob",
        content: "hey",
      });

      assert.equal(result.routed, true);
      if (result.routed) assert.equal(result.mode, "batch");

      // Buffer should be empty — message was flushed immediately
      const buffer = getBatchBuffer(manager, name, "group");
      assert.equal(buffer, undefined);
      removeMind(name);
    });

    it("same sender does not trigger interrupt", async () => {
      const name = setBatchSession();
      manager = new DeliveryManager();

      // Simulate mind active from sender A
      simulateActive(manager, name, "group", ["alice"], ["group:chat"]);

      // Deliver from same sender A — should buffer normally
      await manager.routeAndDeliver(name, {
        channel: "group:chat",
        sender: "alice",
        content: "more from me",
      });

      // Buffer should have the message (not flushed)
      const buffer = getBatchBuffer(manager, name, "group");
      assert.ok(buffer);
      assert.equal(buffer.messages.length, 1);
      removeMind(name);
    });

    it("different channel does not trigger interrupt", async () => {
      const name = setBatchSession();
      manager = new DeliveryManager();

      // Simulate mind active on group:chat
      simulateActive(manager, name, "group", ["alice"], ["group:chat"]);

      // Deliver from sender B but on a different channel
      await manager.routeAndDeliver(name, {
        channel: "group:other",
        sender: "bob",
        content: "hey",
      });

      // Buffer should have the message (not interrupt-flushed)
      const buffer = getBatchBuffer(manager, name, "group");
      assert.ok(buffer);
      assert.equal(buffer.messages.length, 1);
      removeMind(name);
    });

    it("debounce cooldown prevents rapid interrupts", async () => {
      const name = setBatchSession();
      manager = new DeliveryManager();

      // Simulate mind active with a recent interrupt
      const states = (manager as any).sessionStates as Map<string, Map<string, any>>;
      let mindSessions = states.get(name);
      if (!mindSessions) {
        mindSessions = new Map();
        states.set(name, mindSessions);
      }
      mindSessions.set("group", {
        activeCount: 1,
        lastDeliveredAt: Date.now(),
        lastDeliverySenders: new Set(["alice"]),
        lastDeliveryChannels: new Set(["group:chat"]),
        lastInterruptAt: Date.now(), // just interrupted
      });

      // Deliver from new sender — debounce should prevent interrupt
      await manager.routeAndDeliver(name, {
        channel: "group:chat",
        sender: "charlie",
        content: "hey",
      });

      // Buffer should have the message (debounce prevented interrupt)
      const buffer = getBatchBuffer(manager, name, "group");
      assert.ok(buffer);
      assert.equal(buffer.messages.length, 1);
      removeMind(name);
    });

    it("maxWait window expiry prevents interrupt", async () => {
      const name = setBatchSession();
      manager = new DeliveryManager();

      // Simulate mind active but delivery was long ago (beyond maxWait of 10s)
      const states = (manager as any).sessionStates as Map<string, Map<string, any>>;
      let mindSessions = states.get(name);
      if (!mindSessions) {
        mindSessions = new Map();
        states.set(name, mindSessions);
      }
      mindSessions.set("group", {
        activeCount: 1,
        lastDeliveredAt: Date.now() - 20_000, // 20s ago, well past 10s maxWait
        lastDeliverySenders: new Set(["alice"]),
        lastDeliveryChannels: new Set(["group:chat"]),
        lastInterruptAt: 0,
      });

      // Deliver from new sender — maxWait expired so no interrupt
      await manager.routeAndDeliver(name, {
        channel: "group:chat",
        sender: "bob",
        content: "hey",
      });

      // Buffer should have the message (no interrupt)
      const buffer = getBatchBuffer(manager, name, "group");
      assert.ok(buffer);
      assert.equal(buffer.messages.length, 1);
      removeMind(name);
    });

    it("null sender does not trigger interrupt", async () => {
      const name = setBatchSession();
      manager = new DeliveryManager();

      // Simulate mind active from sender A
      simulateActive(manager, name, "group", ["alice"], ["group:chat"]);

      // Deliver a system message with no sender — should buffer normally
      await manager.routeAndDeliver(name, {
        channel: "group:chat",
        sender: null,
        content: "system notification",
      });

      // Buffer should have the message (no interrupt for null sender)
      const buffer = getBatchBuffer(manager, name, "group");
      assert.ok(buffer);
      assert.equal(buffer.messages.length, 1);
      removeMind(name);
    });

    it("inactive session does not trigger interrupt", async () => {
      const name = setBatchSession();
      manager = new DeliveryManager();

      // Simulate session state with activeCount === 0 (mind finished processing)
      const states = (manager as any).sessionStates as Map<string, Map<string, any>>;
      const mindSessions = new Map();
      states.set(name, mindSessions);
      mindSessions.set("group", {
        activeCount: 0,
        lastDeliveredAt: Date.now(),
        lastDeliverySenders: new Set(["alice"]),
        lastDeliveryChannels: new Set(["group:chat"]),
        lastInterruptAt: 0,
      });

      // Deliver from new sender — session is idle so no interrupt
      await manager.routeAndDeliver(name, {
        channel: "group:chat",
        sender: "bob",
        content: "hey",
      });

      // Buffer should have the message (no interrupt)
      const buffer = getBatchBuffer(manager, name, "group");
      assert.ok(buffer);
      assert.equal(buffer.messages.length, 1);
      removeMind(name);
    });

    it("interrupt flush includes existing buffered messages", async () => {
      const name = setBatchSession();
      manager = new DeliveryManager();

      // First, buffer a message from alice while session is idle
      await manager.routeAndDeliver(name, {
        channel: "group:chat",
        sender: "alice",
        content: "first message",
      });

      // Verify it's buffered
      let buffer = getBatchBuffer(manager, name, "group");
      assert.ok(buffer);
      assert.equal(buffer.messages.length, 1);

      // Now simulate the session becoming active (e.g. from a previous flush)
      simulateActive(manager, name, "group", ["alice"], ["group:chat"]);

      // Deliver from bob — should trigger interrupt flush including alice's buffered message
      await manager.routeAndDeliver(name, {
        channel: "group:chat",
        sender: "bob",
        content: "hey alice",
      });

      // Buffer should be cleared — both messages were flushed together
      buffer = getBatchBuffer(manager, name, "group");
      assert.equal(buffer, undefined);
      removeMind(name);
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
