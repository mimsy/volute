import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import { MIND_LEVEL_THREAD } from "../packages/daemon/src/lib/chat/system-events.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  DeliveryManager,
  MAX_DELIVERY_ATTEMPTS,
} from "../packages/daemon/src/lib/delivery/delivery-manager.js";
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
  hangup: () => void;
  connect: () => void;
}> {
  const received: unknown[] = [];
  let shouldFail = false;
  let shouldHangup = false;
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    // Simulate a down/unreachable target: drop the connection so the client `fetch` rejects
    // with a transport error (not an HTTP status) — the "connection refused/reset" case,
    // distinct from a live 500 rejection.
    if (shouldHangup) {
      req.destroy();
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
    hangup: () => {
      shouldHangup = true;
    },
    connect: () => {
      shouldHangup = false;
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
  rules: [{ channel: "*", thread: "main" }],
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
    await removeMind(name);
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
    await removeMind(name);
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
    await removeMind(name);
  });

  it("keys variant rows by baseName but redrives to the variant's own port (no restart replay)", async () => {
    // The live path delivers to the variant's port; if that POST transiently fails, the row
    // is keyed by baseName (so id-scoped cleanup matches) but records target_mind=variant, so
    // redrive re-delivers to the VARIANT — never the parent. The variant must durably receive
    // its own stranded message.
    const parentSrv = await startMindServer();
    const variantSrv = await startMindServer();
    servers.push(parentSrv.server, variantSrv.server);
    variantSrv.fail(); // first delivery to the variant fails → leaves a pending row

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
    assert.equal(pending[0].target_mind, variant, "row records the variant as the delivery target");

    // The variant recovers. Redrive must deliver to the VARIANT's port, not the parent's.
    variantSrv.ok();
    const db = await getDb();
    await db
      .update(deliveryQueue)
      .set({ next_attempt_at: null })
      .where(eq(deliveryQueue.id, pending[0].id));
    await manager.restoreFromDb();
    await waitFor(async () => (await queueRows(parent)).length === 0);
    assert.equal(variantSrv.received.length, 1, "redrive delivered to the variant's own port");
    assert.equal(parentSrv.received.length, 0, "the parent never received the variant's message");

    // A second restore must NOT replay it.
    variantSrv.received.length = 0;
    await manager.restoreFromDb();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(variantSrv.received.length, 0, "cleaned row is not replayed on restart");

    await removeMind(variant);
    await removeMind(parent);
  });

  it("releases gated messages when a matching route is added — no daemon restart", async () => {
    const srv = await startMindServer();
    servers.push(srv.server);
    // gateUnmatched defaults on; only discord is routed initially.
    const name = await registerMind(srv.port, { rules: [{ channel: "discord:*", thread: "d" }] });

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
      JSON.stringify({ rules: [{ channel: "slack:*", thread: "s" }] }),
    );
    clearConfigCache(name); // triggers releaseGated → redrive

    await waitFor(async () => (await queueRows(name)).length === 0);
    // The server also receives the "[New channel]" invite, now delivered as a system event
    // (kind:"event") rather than a routed/gateable message — filter it out to isolate the
    // released backlog message.
    const releasedMsgs = srv.received.filter((b) => (b as { kind?: string }).kind !== "event");
    assert.equal(releasedMsgs.length, 1, "gated message delivered after the route was added");
    await removeMind(name);
  });

  it("dead-letters a permanently-failing delivery after max attempts and notifies the mind", async () => {
    const srv = await startMindServer();
    servers.push(srv.server);
    srv.fail(); // mind always 500s → every delivery attempt fails
    const name = await registerMind(srv.port, IMMEDIATE);

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);
    const notices: {
      mind: string;
      kind: string;
      reason: string;
      thread: string;
      detail: string;
    }[] = [];
    manager.setFailureNotifier(async (input) => {
      notices.push({
        mind: input.mind,
        kind: input.kind,
        reason: input.reason,
        thread: input.thread,
        detail: input.detail,
      });
    });

    // First attempt fails → one pending row with attempts >= 1.
    await manager.routeAndDeliver(name, { channel: "test:ch", sender: "alice", content: "hi" });
    const rows = await queueRows(name, "pending");
    assert.equal(rows.length, 1);

    // Fast-forward the counter to one below the ceiling so the next failure trips it,
    // and clear the backoff window so redrive picks the row up immediately.
    const db = await getDb();
    await db
      .update(deliveryQueue)
      .set({ attempts: MAX_DELIVERY_ATTEMPTS - 1, next_attempt_at: null })
      .where(eq(deliveryQueue.id, rows[0].id));

    await manager.redrive();
    await waitFor(async () => (await queueRows(name, "dead")).length === 1);

    const dead = await queueRows(name, "dead");
    assert.equal(dead.length, 1, "row moves to the terminal dead state");
    assert.equal((await queueRows(name, "pending")).length, 0, "no pending row remains");
    assert.equal(notices.length, 1, "a failure notice is surfaced, not silent");
    assert.equal(notices[0].mind, name);
    assert.equal(notices[0].kind, "delivery_failed");
    assert.equal(notices[0].reason, "delivery_failed");
    assert.equal(notices[0].thread, "main", "notice lands on the message's own (non-$new) thread");
    assert.match(notices[0].detail, /could not be delivered/);
    assert.match(notices[0].detail, /test:ch/, "detail names the channel for recovery");

    // A dead row must never be redriven again.
    srv.ok();
    await manager.redrive();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(srv.received.length, 0, "dead rows are not re-delivered");
    await removeMind(name);
  });

  it("a live rejection on the last permitted attempt still delivers — no dead-letter", async () => {
    const srv = await startMindServer();
    servers.push(srv.server);
    srv.fail();
    const name = await registerMind(srv.port, IMMEDIATE);

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);
    const notices: unknown[] = [];
    manager.setFailureNotifier(async (input) => {
      notices.push(input);
    });

    await manager.routeAndDeliver(name, { channel: "test:ch", sender: "a", content: "hi" });
    const rows = await queueRows(name, "pending");
    assert.equal(rows.length, 1);

    // Sit at exactly the last permitted attempt, then let the mind recover before the sweep.
    const db = await getDb();
    await db
      .update(deliveryQueue)
      .set({ attempts: MAX_DELIVERY_ATTEMPTS - 1, next_attempt_at: null })
      .where(eq(deliveryQueue.id, rows[0].id));
    srv.ok();

    await manager.redrive();
    await waitFor(async () => (await queueRows(name)).length === 0);
    assert.equal(srv.received.length, 1, "the final permitted attempt delivered");
    assert.equal(notices.length, 0, "a successful final attempt is never dead-lettered");
    await removeMind(name);
  });

  it("a down/unreachable target is retried without bumping attempts, never dead-lettered", async () => {
    const srv = await startMindServer();
    servers.push(srv.server);
    srv.hangup(); // connection drops → transport failure, not a live rejection
    const name = await registerMind(srv.port, IMMEDIATE);

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true); // redrive guard checks the BASE mind, which is "up"
    const notices: unknown[] = [];
    manager.setFailureNotifier(async (input) => {
      notices.push(input);
    });

    await manager.routeAndDeliver(name, { channel: "test:ch", sender: "a", content: "hi" });
    let rows = await queueRows(name, "pending");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].attempts, 0, "a transport failure must not bump the attempt counter");

    // Across several sweeps the row stays pending with zero attempts — it is NOT progressing
    // toward the dead-letter ceiling just because the target is offline.
    const db = await getDb();
    for (let i = 0; i < 3; i++) {
      await db
        .update(deliveryQueue)
        .set({ next_attempt_at: null })
        .where(eq(deliveryQueue.id, rows[0].id));
      await manager.redrive();
      await waitFor(async () => {
        const r = (await queueRows(name, "pending"))[0];
        return r != null && r.next_attempt_at != null; // attempt completed, backoff re-set
      });
      rows = await queueRows(name, "pending");
      assert.equal(rows.length, 1, "row stays pending while the target is unreachable");
      assert.equal(rows[0].attempts, 0, "still zero attempts after an unreachable sweep");
    }
    assert.equal(notices.length, 0, "an unreachable target is never dead-lettered");

    // Target comes back → the preserved message finally delivers.
    srv.connect();
    await db
      .update(deliveryQueue)
      .set({ next_attempt_at: null })
      .where(eq(deliveryQueue.id, rows[0].id));
    await manager.redrive();
    await waitFor(async () => (await queueRows(name)).length === 0);
    assert.equal(srv.received.length, 1, "delivered once the target recovered");
    assert.equal(notices.length, 0, "no dead-letter notice for a recovered target");
    await removeMind(name);
  });

  it("routes the dead-letter notice for a $new session to the mind-level thread", async () => {
    const srv = await startMindServer();
    servers.push(srv.server);
    srv.fail();
    const name = await registerMind(srv.port, IMMEDIATE);

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);
    const notices: { thread: string }[] = [];
    manager.setFailureNotifier(async (input) => {
      notices.push({ thread: input.thread });
    });

    // A row whose thread is an ephemeral $new-style session — the only message that would
    // ever run that thread is the one being dropped.
    const anyMgr = manager as unknown as {
      persistToQueue: (m: string, s: string, p: unknown) => Promise<number | undefined>;
      deliverToMind: (m: string, s: string, p: unknown, cfg: unknown, id?: number) => Promise<void>;
    };
    const thread = `new-${Date.now()}-abc123`;
    const payload = { channel: "test:ch", sender: "a", content: "hi" };
    const id = await anyMgr.persistToQueue(name, thread, payload);
    assert.ok(id);
    const db = await getDb();
    await db
      .update(deliveryQueue)
      .set({ attempts: MAX_DELIVERY_ATTEMPTS - 1 })
      .where(eq(deliveryQueue.id, id));
    await anyMgr.deliverToMind(name, thread, payload, { delivery: { mode: "immediate" } }, id);

    await waitFor(async () => (await queueRows(name, "dead")).length === 1);
    assert.equal(notices.length, 1);
    assert.equal(
      notices[0].thread,
      MIND_LEVEL_THREAD,
      "an ephemeral $new thread routes the notice to MIND_LEVEL_THREAD",
    );
    await removeMind(name);
  });

  it("terminalizes every row of a failing batch even when the failure notifier throws", async () => {
    const srv = await startMindServer();
    servers.push(srv.server);
    srv.fail();
    const name = await registerMind(srv.port, IMMEDIATE);

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);
    manager.setFailureNotifier(async () => {
      throw new Error("notifier boom");
    });

    const anyMgr = manager as unknown as {
      persistToQueue: (m: string, s: string, p: unknown) => Promise<number | undefined>;
      deliverBatchToMind: (m: string, s: string, msgs: unknown[], cfg: unknown) => Promise<void>;
    };
    const p1 = { channel: "test:ch", sender: "a", content: "one" };
    const p2 = { channel: "test:ch", sender: "b", content: "two" };
    const id1 = await anyMgr.persistToQueue(name, "main", p1);
    const id2 = await anyMgr.persistToQueue(name, "main", p2);
    assert.ok(id1 && id2);

    // Both at the last permitted attempt; the batch POST 500s → both cross the ceiling at once.
    const db = await getDb();
    await db
      .update(deliveryQueue)
      .set({ attempts: MAX_DELIVERY_ATTEMPTS - 1 })
      .where(inArray(deliveryQueue.id, [id1, id2]));

    // A throwing notifier must not propagate or leave a row un-terminalized (no hot-loop).
    await anyMgr.deliverBatchToMind(
      name,
      "main",
      [
        { payload: p1, channel: "test:ch", sender: "a", createdAt: Date.now(), queueId: id1 },
        { payload: p2, channel: "test:ch", sender: "b", createdAt: Date.now(), queueId: id2 },
      ],
      { delivery: { mode: "immediate" }, interrupt: true },
    );

    assert.equal((await queueRows(name, "dead")).length, 2, "both batch rows terminalize");
    assert.equal((await queueRows(name, "pending")).length, 0, "no row left pending to hot-loop");
    await removeMind(name);
  });

  it("the terminal transition is idempotent and names the actual rejecting variant target", async () => {
    const srv = await startMindServer();
    servers.push(srv.server);
    srv.fail();
    const name = await registerMind(srv.port, IMMEDIATE);
    const variant = `${name}-v1`;

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);
    const notices: { detail: string }[] = [];
    manager.setFailureNotifier(async (input) => {
      notices.push({ detail: input.detail });
    });

    // A pending row keyed by the base name but TARGETED at a variant, at the last attempt.
    const db = await getDb();
    const inserted = await db
      .insert(deliveryQueue)
      .values({
        mind: name,
        target_mind: variant,
        thread: "main",
        channel: "test:ch",
        sender: "alice",
        status: "pending",
        attempts: MAX_DELIVERY_ATTEMPTS - 1,
        payload: "{}",
      })
      .returning({ id: deliveryQueue.id });
    const id = inserted[0].id;

    const anyMgr = manager as unknown as {
      scheduleRetry: (ids: number[], opts: { liveRejection: boolean }) => Promise<void>;
    };

    // First live rejection trips the ceiling → one notice, row terminal, detail names the variant.
    await anyMgr.scheduleRetry([id], { liveRejection: true });
    assert.equal((await queueRows(name, "dead")).length, 1, "row flips to dead");
    assert.equal(notices.length, 1, "one dead-letter notice");
    assert.match(
      notices[0].detail,
      new RegExp(`variant ${variant}`),
      "detail names the target variant",
    );

    // Re-processing the now-dead row must NOT fire a second notice (idempotent transition).
    await anyMgr.scheduleRetry([id], { liveRejection: true });
    assert.equal(notices.length, 1, "no duplicate notice on a re-processed dead row");
    assert.equal((await queueRows(name, "dead")).length, 1);
    await removeMind(name);
  });

  it("dead-lettering also notifies a mind sender, naming the recipient for DM channels", async () => {
    const name = `dur-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await addMind(name, 4901);

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);
    manager.setFailureNotifier(async () => {});
    const senderNotices: { sender: string; channel: string; reason: string }[] = [];
    manager.setSenderFailureNotifier(async (sender, channel, reason) => {
      senderNotices.push({ sender, channel, reason });
    });

    // Two rows crossing the ceiling at once: a DM (channel named after the sender, as the
    // recipient's queue sees it) and a shared channel. The sender name is deliberately NOT
    // slug-identical (uppercase + underscore) — fan-out stores DM slugs as @slugify(sender),
    // so the rename must compare against the slugified name, not the raw one.
    const db = await getDb();
    const values = [
      { channel: "@peer-mind", sender: "Peer_Mind" }, // DM: recipient-side slug names the sender
      { channel: "test:ch", sender: "Peer_Mind" }, // shared channel: same slug for both sides
    ].map((v) => ({
      mind: name,
      thread: "main",
      status: "pending",
      attempts: MAX_DELIVERY_ATTEMPTS - 1,
      payload: "{}",
      ...v,
    }));
    const inserted = await db
      .insert(deliveryQueue)
      .values(values)
      .returning({ id: deliveryQueue.id });

    const anyMgr = manager as unknown as {
      scheduleRetry: (ids: number[], opts: { liveRejection: boolean }) => Promise<void>;
    };
    await anyMgr.scheduleRetry(
      inserted.map((r) => r.id),
      { liveRejection: true },
    );

    assert.equal((await queueRows(name, "dead")).length, 2);
    assert.equal(senderNotices.length, 2, "one sender notice per distinct (sender, channel)");
    const channels = senderNotices.map((n) => n.channel).sort();
    assert.deepEqual(
      channels,
      [`@${name}`, "test:ch"],
      "DM channel renamed to the recipient from the sender's perspective",
    );
    for (const n of senderNotices) {
      assert.equal(n.sender, "Peer_Mind");
      assert.match(n.reason, /rejected/);
    }
    await removeMind(name);
  });

  it("removeMind purges the mind's delivery_queue rows (owned and variant-targeted)", async () => {
    const db = await getDb();
    const base = `dur-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const variant = `${base}-v1`;
    const other = `dur-other-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // Rows owned by the mind (keyed by base name) plus a row keyed under a different base
    // but targeted at our mind's variant. removeMind must drop both.
    await db.insert(deliveryQueue).values([
      { mind: base, target_mind: base, thread: "main", status: "pending", payload: "{}" },
      { mind: base, target_mind: base, thread: "main", status: "dead", payload: "{}" },
      { mind: other, target_mind: variant, thread: "main", status: "pending", payload: "{}" },
      // An unrelated row that must survive.
      { mind: other, target_mind: other, thread: "main", status: "pending", payload: "{}" },
    ]);

    await removeMind(base);
    assert.equal((await queueRows(base)).length, 0, "base-owned rows are purged");

    await removeMind(variant);
    const survivors = await db.select().from(deliveryQueue).where(eq(deliveryQueue.mind, other));
    assert.equal(survivors.length, 1, "only the variant-targeted row is purged; the rest survive");
    assert.equal(survivors[0].target_mind, other);

    await db.delete(deliveryQueue).where(eq(deliveryQueue.mind, other));
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
    await removeMind(name);
  });
});
