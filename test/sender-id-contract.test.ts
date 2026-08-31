/**
 * The `mind_history.sender_id` integrity contract (#1017).
 *
 * `sender` is display text with many writers; `sender_id` is a security identifier
 * with one rule: it is written ONLY by paths that actually authenticated the sender
 * on the request, and is null everywhere else. Pinned here: the authenticated chat
 * path writes the principal's users.id; the daemon-token sender override and
 * cloud-relay inbound write null; and the queue round-trip — a gated message
 * releases with the senderId its payload carried, and a legacy queue row without
 * one releases as null. The bridge and mail nulls are pinned alongside their
 * namespacing assertions in test/sender-namespacing.test.ts.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createUser } from "../packages/daemon/src/lib/auth.js";
import { consumeQueuedMessages } from "../packages/daemon/src/lib/cloud-sync.js";
import {
  initMindManager,
  tryGetMindManager,
} from "../packages/daemon/src/lib/daemon/mind-manager.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { DeliveryManager } from "../packages/daemon/src/lib/delivery/delivery-manager.js";
import { clearConfigCache } from "../packages/daemon/src/lib/delivery/delivery-router.js";
import { addMind, removeMind, setMindRunning } from "../packages/daemon/src/lib/mind/registry.js";
import {
  conversations,
  deliveryQueue,
  messages,
  mindHistory,
  users,
} from "../packages/daemon/src/lib/schema.js";
import { chatApp } from "../packages/daemon/src/web/api/chat.js";
import { authMiddleware, createSession } from "../packages/daemon/src/web/middleware/auth.js";

const MIND = "sid-target";
const SENDER_MIND = "sid-sender";
const HUMAN = "sid-human";
const PORT = 41991;

/** Mark a mind as running in the MindManager map without spawning a process. */
function markRunning(name: string): void {
  if (!tryGetMindManager()) initMindManager();
  const manager = tryGetMindManager()!;
  (manager as unknown as { minds: Map<string, unknown> }).minds.set(name, {
    child: {},
    port: PORT,
  });
}

/** Route everything so nothing gates — a gated message writes no inbound row (#420). */
function routeEverything(name: string): void {
  const configDir = resolve(process.env.VOLUTE_HOME!, "minds", name, "home/.config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(resolve(configDir, "routes.json"), JSON.stringify({ rules: [{ channel: "*" }] }));
  clearConfigCache(name);
}

/** The inbound row is written by fan-out's fire-and-forget delivery, just after the 200. */
async function inboundRows(mind: string) {
  const db = await getDb();
  const deadline = Date.now() + 3000;
  do {
    const rows = await db
      .select()
      .from(mindHistory)
      .where(and(eq(mindHistory.mind, mind), eq(mindHistory.type, "inbound")));
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 25));
  } while (Date.now() < deadline);
  return [];
}

async function cleanup(): Promise<void> {
  const db = await getDb();
  for (const mind of [MIND, SENDER_MIND]) {
    await db.delete(mindHistory).where(eq(mindHistory.mind, mind));
    await db.delete(deliveryQueue).where(eq(deliveryQueue.mind, mind));
    await removeMind(mind).catch(() => {});
    (tryGetMindManager() as unknown as { minds: Map<string, unknown> } | undefined)?.minds.delete(
      mind,
    );
    rmSync(resolve(process.env.VOLUTE_HOME!, "minds", mind), { recursive: true, force: true });
  }
  const convs = await db.select().from(conversations).all();
  for (const c of convs) await db.delete(messages).where(eq(messages.conversation_id, c.id));
  await db.delete(conversations);
  for (const username of [HUMAN, MIND, SENDER_MIND]) {
    await db.delete(users).where(eq(users.username, username));
  }
  clearConfigCache();
}

function appWithCookieAuth() {
  return new Hono().use("/api/v1/*", authMiddleware).route("/api/v1/chat", chatApp);
}

describe("mind_history.sender_id integrity contract (#1017)", () => {
  afterEach(cleanup);

  it("the authenticated chat path writes the principal's users.id", async () => {
    await addMind(MIND, PORT);
    await setMindRunning(MIND, true);
    markRunning(MIND);
    routeEverything(MIND);

    const human = await createUser(HUMAN, "pass");
    const cookie = await createSession(human.id);
    const res = await appWithCookieAuth().request("/api/v1/chat", {
      method: "POST",
      headers: { Cookie: `volute_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ targetMind: MIND, message: "hello" }),
    });
    assert.equal(res.status, 200);

    const rows = await inboundRows(MIND);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sender, HUMAN);
    assert.equal(
      rows[0].sender_id,
      human.id,
      "an authenticated send must carry the principal's id",
    );
  });

  it("the daemon-token sender override writes null — the daemon asserted the name, nobody authenticated it", async () => {
    await addMind(MIND, PORT);
    await addMind(SENDER_MIND, PORT + 1);
    await setMindRunning(MIND, true);
    markRunning(MIND);
    routeEverything(MIND);

    // Through the LIVE resolver: authMiddleware maps a Bearer VOLUTE_DAEMON_TOKEN
    // to the id-0 daemon principal — the contract must hold for the real token
    // path, not a hand-built fixture.
    const savedToken = process.env.VOLUTE_DAEMON_TOKEN;
    process.env.VOLUTE_DAEMON_TOKEN = "sid-test-daemon-token";
    let res: Response;
    try {
      res = await appWithCookieAuth().request("/api/v1/chat", {
        method: "POST",
        headers: {
          Authorization: "Bearer sid-test-daemon-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ targetMind: MIND, sender: SENDER_MIND, message: "relayed" }),
      });
    } finally {
      if (savedToken === undefined) delete process.env.VOLUTE_DAEMON_TOKEN;
      else process.env.VOLUTE_DAEMON_TOKEN = savedToken;
    }
    assert.equal(res.status, 200);

    const rows = await inboundRows(MIND);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sender, SENDER_MIND, "the display sender is still recorded");
    assert.equal(
      rows[0].sender_id,
      null,
      "a daemon-asserted sender name must never mint an authenticated id",
    );
  });

  it("cloud-relay inbound writes null — the queue carries sender text this daemon never authenticated", async () => {
    await addMind(MIND, PORT);
    await setMindRunning(MIND, true);
    markRunning(MIND);
    routeEverything(MIND);

    // A stand-in volute.systems queue: one pending message, then acknowledge-and-drain.
    const queued = [
      { id: "q1", mind: MIND, channel: "@cloud-alice", sender: "cloud-alice", content: "hi" },
    ];
    const server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(req.method === "GET" ? JSON.stringify(queued) : "{}");
    });
    const port: number = await new Promise((r) => {
      server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port));
    });
    const savedUrl = process.env.VOLUTE_WEBHOOK_URL;
    process.env.VOLUTE_WEBHOOK_URL = `http://127.0.0.1:${port}`;
    try {
      await consumeQueuedMessages();
    } finally {
      if (savedUrl === undefined) delete process.env.VOLUTE_WEBHOOK_URL;
      else process.env.VOLUTE_WEBHOOK_URL = savedUrl;
      server.close();
    }

    const rows = await inboundRows(MIND);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sender, "cloud-alice");
    assert.equal(rows[0].sender_id, null, "relayed cloud identity confers no authenticated id");
  });

  describe("queue round-trip", () => {
    let manager: DeliveryManager | undefined;

    afterEach(() => {
      manager?.dispose();
      manager = undefined;
    });

    it("a gated message releases with the senderId its payload carried", async () => {
      await addMind(MIND, PORT);
      // Only discord is routed: the message below gates (gateUnmatched defaults on).
      const configDir = resolve(process.env.VOLUTE_HOME!, "minds", MIND, "home/.config");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        resolve(configDir, "routes.json"),
        JSON.stringify({ rules: [{ channel: "discord:*", thread: "d" }] }),
      );
      clearConfigCache(MIND);

      manager = new DeliveryManager();
      manager.setRunningCheck(() => true);
      const res = await manager.routeAndDeliver(MIND, {
        channel: "slack:random",
        sender: "alice",
        senderId: 4242,
        content: "held",
      });
      assert.equal(res.routed && res.mode, "gated");

      // Gated messages write no inbound row on arrival (#420)…
      const db = await getDb();
      const before = await db
        .select()
        .from(mindHistory)
        .where(and(eq(mindHistory.mind, MIND), eq(mindHistory.type, "inbound")));
      assert.equal(before.length, 0);

      // …so the release is the sole recording point, and it must not drop the id.
      writeFileSync(
        resolve(configDir, "routes.json"),
        JSON.stringify({ rules: [{ channel: "slack:*", thread: "s" }] }),
      );
      // clearConfigCache itself fires the manager's routes-change listener, so this
      // explicit call may find the work already done — it serializes behind the
      // listener's release either way, so after it the inbound row must exist.
      clearConfigCache(MIND);
      await manager.releaseGated(MIND);

      const rows = await inboundRows(MIND);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].sender, "alice");
      assert.equal(rows[0].sender_id, 4242, "the release must carry the payload's senderId");
    });

    it("senderId never reaches the mind process on the wire", async () => {
      // The mind's side of the POST is an untrusted process: a field it could echo
      // back must not exist in a shape that looks authoritative, so the daemon strips
      // senderId at the wire boundary (like held/inboundDeferred).
      const received: Record<string, unknown>[] = [];
      const server = createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => {
          raw += c;
        });
        req.on("end", () => {
          received.push(JSON.parse(raw));
          res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
        });
      });
      const port: number = await new Promise((r) => {
        server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port));
      });
      try {
        await addMind(MIND, port);
        routeEverything(MIND);
        manager = new DeliveryManager();
        manager.setRunningCheck(() => true);
        await manager.routeAndDeliver(MIND, {
          channel: "@alice",
          sender: "alice",
          senderId: 7,
          content: "hi",
        });
        const deadline = Date.now() + 3000;
        while (received.length === 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 25));
        }
        assert.equal(received.length, 1);
        assert.ok(!("senderId" in received[0]), "the wire payload must not carry senderId");
        assert.equal(received[0].sender, "alice", "the display sender still crosses");
      } finally {
        server.close();
      }
    });

    it("a legacy queue row whose payload predates senderId releases as null", async () => {
      await addMind(MIND, PORT);
      routeEverything(MIND);

      const db = await getDb();
      await db.insert(deliveryQueue).values({
        mind: MIND,
        thread: "main",
        channel: "slack:random",
        sender: "alice",
        status: "gated",
        // Hand-built JSON, exactly as a pre-#1017 daemon persisted it: no senderId key.
        payload: JSON.stringify({ channel: "slack:random", sender: "alice", content: "old" }),
      });

      manager = new DeliveryManager();
      manager.setRunningCheck(() => true);
      const { released } = await manager.releaseGated(MIND);
      assert.equal(released, 1);

      const rows = await inboundRows(MIND);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].sender_id, null, "an unvouched legacy row stays null, not invented");
    });
  });
});
