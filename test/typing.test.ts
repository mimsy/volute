import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createUser } from "../src/lib/auth.js";
import { getDb } from "../src/lib/db.js";
import { sessions, users } from "../src/lib/schema.js";
import { getTypingMap, TypingMap } from "../src/lib/typing.js";
import { createSession } from "../src/web/middleware/auth.js";

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

  it("singleton re-creates after dispose", () => {
    const map1 = getTypingMap();
    map1.dispose();
    const map2 = getTypingMap();
    assert.notStrictEqual(map1, map2);
    map2.dispose();
  });
});

describe("typing routes", () => {
  let sessionId: string;

  async function cleanup() {
    const db = await getDb();
    await db.delete(sessions);
    await db.delete(users);
    getTypingMap().dispose();
  }

  beforeEach(cleanup);
  afterEach(cleanup);

  async function setupAuth(): Promise<string> {
    const user = await createUser("typing-admin", "pass");
    sessionId = await createSession(user.id);
    return sessionId;
  }

  it("GET returns empty typing when nobody is typing", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request("/api/minds/test-agent/typing?channel=discord:123", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { typing: [] });
  });

  it("POST + GET round-trip", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../src/web/app.js");

    // POST active:true
    const postRes = await app.request("http://localhost/api/minds/test-agent/typing", {
      method: "POST",
      headers: {
        Cookie: `volute_session=${cookie}`,
        Origin: "http://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: "discord:123", sender: "alice", active: true }),
    });
    assert.equal(postRes.status, 200);
    const postBody = await postRes.json();
    assert.deepEqual(postBody, { ok: true });

    // GET to verify sender appears
    const getRes = await app.request("/api/minds/test-agent/typing?channel=discord:123", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.deepEqual(getBody, { typing: ["alice"] });
  });

  it("POST active:false clears sender", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../src/web/app.js");

    // Set typing
    await app.request("http://localhost/api/minds/test-agent/typing", {
      method: "POST",
      headers: {
        Cookie: `volute_session=${cookie}`,
        Origin: "http://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: "discord:123", sender: "bob", active: true }),
    });

    // Clear typing
    const clearRes = await app.request("http://localhost/api/minds/test-agent/typing", {
      method: "POST",
      headers: {
        Cookie: `volute_session=${cookie}`,
        Origin: "http://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: "discord:123", sender: "bob", active: false }),
    });
    assert.equal(clearRes.status, 200);

    // Verify cleared
    const getRes = await app.request("/api/minds/test-agent/typing?channel=discord:123", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(getRes.status, 200);
    const body = await getRes.json();
    assert.deepEqual(body, { typing: [] });
  });

  it("GET requires channel query param", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request("/api/minds/test-agent/typing", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error);
  });

  it("POST requires channel and sender", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request("http://localhost/api/minds/test-agent/typing", {
      method: "POST",
      headers: {
        Cookie: `volute_session=${cookie}`,
        Origin: "http://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ active: true }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error);
  });
});
