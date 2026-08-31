/**
 * The `mind_history.sender_id` integrity contract (#1017).
 *
 * `sender` is display text with many writers; `sender_id` is a security identifier
 * with one rule: it is written ONLY by paths that actually authenticated the sender
 * on the request, and is null everywhere else. These tests pin both halves —
 * the authenticated chat path writes the principal's users.id, and every vouchless
 * path (daemon-token sender override, bridge/mail/cloud inbound) writes null — plus
 * the queue round-trip: a gated message releases with the senderId its payload
 * carried, and a legacy queue row without one releases as null.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createUser } from "../packages/daemon/src/lib/auth.js";
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
  for (let i = 0; i < 50; i++) {
    const rows = await db
      .select()
      .from(mindHistory)
      .where(and(eq(mindHistory.mind, mind), eq(mindHistory.type, "inbound")));
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 10));
  }
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

/** The bridges-style harness: the daemon token principal, injected directly. */
function appAsDaemon() {
  return new Hono()
    .use(async (c, next) => {
      c.set("user", { id: 0, username: "daemon", role: "admin", user_type: "system" } as never);
      await next();
    })
    .route("/api/v1/chat", chatApp);
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

    const res = await appAsDaemon().request("/api/v1/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetMind: MIND, sender: SENDER_MIND, message: "relayed" }),
    });
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
