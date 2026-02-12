import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { TypingMap } from "../src/lib/typing.js";

describe("TypingMap", () => {
  let map: TypingMap;

  afterEach(() => {
    map?.dispose();
  });

  it("returns empty array for unknown channel", () => {
    map = new TypingMap();
    assert.deepEqual(map.get("unknown:123"), []);
  });

  it("tracks a sender typing in a channel", () => {
    map = new TypingMap();
    map.set("discord:123", "alice");
    assert.deepEqual(map.get("discord:123"), ["alice"]);
  });

  it("tracks multiple senders in a channel", () => {
    map = new TypingMap();
    map.set("discord:123", "alice");
    map.set("discord:123", "bob");
    const senders = map.get("discord:123");
    assert.equal(senders.length, 2);
    assert.ok(senders.includes("alice"));
    assert.ok(senders.includes("bob"));
  });

  it("removes a sender when cleared", () => {
    map = new TypingMap();
    map.set("discord:123", "alice");
    map.set("discord:123", "bob");
    map.delete("discord:123", "alice");
    assert.deepEqual(map.get("discord:123"), ["bob"]);
  });

  it("does not return expired entries", () => {
    map = new TypingMap();
    map.set("discord:123", "alice", { ttlMs: 0 });
    assert.deepEqual(map.get("discord:123"), []);
  });

  it("persistent entries do not expire", () => {
    map = new TypingMap();
    map.set("discord:123", "alice", { ttlMs: 0, persistent: true });
    assert.deepEqual(map.get("discord:123"), ["alice"]);
  });

  it("channels are independent", () => {
    map = new TypingMap();
    map.set("discord:123", "alice");
    map.set("discord:456", "bob");
    assert.deepEqual(map.get("discord:123"), ["alice"]);
    assert.deepEqual(map.get("discord:456"), ["bob"]);
  });

  it("refreshing updates expiry", () => {
    map = new TypingMap();
    map.set("discord:123", "alice", { ttlMs: 0 });
    // Expired now
    assert.deepEqual(map.get("discord:123"), []);
    // Refresh with a long TTL
    map.set("discord:123", "alice", { ttlMs: 60000 });
    assert.deepEqual(map.get("discord:123"), ["alice"]);
  });
});
