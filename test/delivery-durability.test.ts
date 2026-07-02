import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { DeliveryManager } from "../packages/daemon/src/lib/delivery/delivery-manager.js";
import {
  clearConfigCache,
  type RoutingConfig,
} from "../packages/daemon/src/lib/delivery/delivery-router.js";
import { addMind, addVariant, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import { deliveryQueue } from "../packages/daemon/src/lib/schema.js";

// --- Helpers ---

/** A mind HTTP server that records received message bodies. Optional response delay. */
async function startMindServer(delayMs = 0): Promise<{
  server: Server;
  port: number;
  received: unknown[];
  fail: () => void;
  ok: () => void;
}> {
  const received: unknown[] = [];
  let shouldFail = false;
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const respond = () => {
        if (shouldFail) {
          res.writeHead(500).end("nope");
          return;
        }
        try {
          received.push(JSON.parse(raw));
        } catch {
          received.push(raw);
        }
        res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
      };
      if (delayMs > 0) setTimeout(respond, delayMs);
      else respond();
    });
  });
  const port: number = await new Promise((res) => {
    server.listen(0, "127.0.0.1", () => res((server.address() as { port: number }).port));
  });
  return {
    server,
    port,
    received,
    fail: () => {
      shouldFail = true;
    },
    ok: () => {
      shouldFail = false;
    },
  };
}

async function registerMind(port: number, config: RoutingConfig | object): Promise<string> {
  const name = `dur-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await addMind(name, port);
  const configDir = resolve(process.env.VOLUTE_HOME!, "minds", name, "home/.config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(resolve(configDir, "routes.json"), JSON.stringify(config));
  return name;
}

async function queueRows(mind: string, status?: string) {
  const db = await getDb();
  const where = status
    ? and(eq(deliveryQueue.mind, mind), eq(deliveryQueue.status, status))
    : eq(deliveryQueue.mind, mind);
  return db.select().from(deliveryQueue).where(where);
}

async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor timed out");
}

const IMMEDIATE: RoutingConfig = {
  rules: [{ channel: "*", session: "main" }],
  gateUnmatched: false,
};

describe("DeliveryManager durability", () => {
  let manager: DeliveryManager;
  const servers: Server[] = [];

  afterEach(() => {
    manager?.dispose();
    clearConfigCache();
    for (const s of servers.splice(0)) s.close();
  });

  it("persists to the queue before POST and marks done by row id on ack", async () => {
    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, IMMEDIATE);

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);

    await manager.routeAndDeliver(name, { channel: "test:ch", sender: "alice", content: "hi" });

    // Ack received → row deleted by its specific id, and the mind got exactly one POST.
    assert.equal(srv.received.length, 1);
    assert.equal((await queueRows(name)).length, 0, "row should be deleted after ack");
    removeMind(name);
  });

  it("leaves a pending row when the POST fails, then the redrive loop delivers it", async () => {
    const srv = await startMindServer();
    servers.push(srv.server);
    srv.fail(); // mind responds 500 → delivery fails
    const name = await registerMind(srv.port, IMMEDIATE);

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);

    await manager.routeAndDeliver(name, { channel: "test:ch", sender: "alice", content: "hi" });

    // Persist-before-POST: the row survives a failed delivery, with a bumped attempt count.
    let rows = await queueRows(name, "pending");
    assert.equal(rows.length, 1, "failed delivery must leave a pending row");
    assert.ok(rows[0].attempts >= 1, "attempt counter should be bumped on failure");

    // Now the mind recovers. Clear the backoff window and redrive.
    srv.ok();
    const db = await getDb();
    await db
      .update(deliveryQueue)
      .set({ next_attempt_at: null })
      .where(eq(deliveryQueue.id, rows[0].id));

    await manager.redrive();
    await waitFor(async () => (await queueRows(name)).length === 0);
    assert.equal(srv.received.length, 1, "redrive delivered the stranded message");

    rows = await queueRows(name);
    assert.equal(rows.length, 0, "row cleaned after successful redrive");
    removeMind(name);
  });

  it("marks only the batch's own rows done — no broad DELETE races concurrent inserts", async () => {
    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, IMMEDIATE);

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);

    // Two independently-persisted rows for the same (mind, session).
    const anyMgr = manager as unknown as {
      persistToQueue: (m: string, s: string, p: unknown) => Promise<number | undefined>;
      deliverBatchToMind: (m: string, s: string, msgs: unknown[], cfg: unknown) => Promise<void>;
    };
    const p1 = { channel: "test:ch", sender: "a", content: "one" };
    const p2 = { channel: "test:ch", sender: "b", content: "two" };
    const id1 = await anyMgr.persistToQueue(name, "main", p1);
    const id2 = await anyMgr.persistToQueue(name, "main", p2);
    assert.ok(id1 && id2);

    // Deliver a batch containing ONLY row 1.
    await anyMgr.deliverBatchToMind(
      name,
      "main",
      [{ payload: p1, channel: "test:ch", sender: "a", createdAt: Date.now(), queueId: id1 }],
      { delivery: { mode: "immediate" }, interrupt: true },
    );

    const remaining = await queueRows(name);
    assert.equal(remaining.length, 1, "the concurrently-enqueued row must survive");
    assert.equal(remaining[0].id, id2, "only the batch's own row was deleted");
    removeMind(name);
  });

  it("keys queue rows by baseName for variants and cleans them by id (no restart replay)", async () => {
    // Variant delivery goes to the variant's port (here: failing); redrive re-resolves
    // the baseName and delivers to the parent's port.
    const parentSrv = await startMindServer();
    const variantSrv = await startMindServer();
    servers.push(parentSrv.server, variantSrv.server);
    variantSrv.fail();

    const parent = `dur-parent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const variant = `${parent}-v1`;
    await addMind(parent, parentSrv.port);
    await addVariant(variant, parent, variantSrv.port, "/tmp/variant-dir", "branch");
    // routes live under the parent's mind dir
    const configDir = resolve(process.env.VOLUTE_HOME!, "minds", parent, "home/.config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(resolve(configDir, "routes.json"), JSON.stringify(IMMEDIATE));

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);

    // Deliver to the VARIANT name — the failing POST leaves a pending row keyed by baseName.
    await manager.routeAndDeliver(variant, { channel: "test:ch", sender: "a", content: "hi" });

    const pending = await queueRows(parent, "pending");
    assert.equal(pending.length, 1, "row is keyed by the base name, not the variant");
    assert.equal((await queueRows(variant)).length, 0, "nothing is keyed under the variant name");

    // Restore-from-db (redrive): the row delivers (to the parent) and is cleaned, not replayed.
    const db = await getDb();
    await db
      .update(deliveryQueue)
      .set({ next_attempt_at: null })
      .where(eq(deliveryQueue.id, pending[0].id));
    await manager.restoreFromDb();
    await waitFor(async () => (await queueRows(parent)).length === 0);
    assert.equal(parentSrv.received.length, 1);

    // A second restore must NOT replay it.
    parentSrv.received.length = 0;
    await manager.restoreFromDb();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(parentSrv.received.length, 0, "cleaned row is not replayed on restart");

    removeMind(variant);
    removeMind(parent);
  });

  it("releases gated messages when a matching route is added — no daemon restart", async () => {
    const srv = await startMindServer();
    servers.push(srv.server);
    // gateUnmatched defaults on; only discord is routed initially.
    const name = await registerMind(srv.port, { rules: [{ channel: "discord:*", session: "d" }] });

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);

    const res = await manager.routeAndDeliver(name, {
      channel: "slack:random",
      sender: "z",
      content: "held",
    });
    assert.equal(res.routed && res.mode, "gated");
    assert.equal((await queueRows(name, "gated")).length, 1);

    // Add a matching route and invalidate the config cache (as a routes.json write would).
    const configDir = resolve(process.env.VOLUTE_HOME!, "minds", name, "home/.config");
    writeFileSync(
      resolve(configDir, "routes.json"),
      JSON.stringify({ rules: [{ channel: "slack:*", session: "s" }] }),
    );
    clearConfigCache(name); // triggers releaseGated → redrive

    await waitFor(async () => (await queueRows(name)).length === 0);
    assert.equal(srv.received.length, 1, "gated message delivered after the route was added");
    removeMind(name);
  });

  it("drains two rapid immediate messages to one session in order", async () => {
    const srv = await startMindServer(80); // slow enough that a reorder would surface
    servers.push(srv.server);
    const name = await registerMind(srv.port, IMMEDIATE);

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);

    const p1 = manager.routeAndDeliver(name, { channel: "test:ch", sender: "a", content: "one" });
    // Let the first delivery enter the per-session chain and begin its (slow) POST.
    await new Promise((r) => setTimeout(r, 20));
    const p2 = manager.routeAndDeliver(name, { channel: "test:ch", sender: "b", content: "two" });
    await Promise.all([p1, p2]);

    const texts = srv.received.map((b) => {
      const body = b as { content?: string };
      return body.content;
    });
    assert.deepEqual(texts, ["one", "two"], "messages delivered in submission order");
    removeMind(name);
  });
});
