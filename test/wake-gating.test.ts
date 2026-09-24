import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { deliverEvent } from "../packages/daemon/src/lib/chat/system-events.js";
import {
  getSleepManagerIfReady,
  initSleepManager,
} from "../packages/daemon/src/lib/daemon/sleep-manager.js";
import { hasTurnSlot, releaseTurnSlot } from "../packages/daemon/src/lib/daemon/turn-slots.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  DeliveryManager,
  initDeliveryManager,
  MAX_DELIVERY_ATTEMPTS,
} from "../packages/daemon/src/lib/delivery/delivery-manager.js";
import {
  classifySender,
  clearConfigCache,
  type DeliveryPayload,
  type RoutingConfig,
  reportRoutesConfigProblems,
  resolveDeliveryMode,
  resolveRoute,
  routesConfigProblems,
} from "../packages/daemon/src/lib/delivery/delivery-router.js";
import {
  deliverBatch,
  deliverMessage,
} from "../packages/daemon/src/lib/delivery/message-delivery.js";
import { addMind, removeMind, stateDir } from "../packages/daemon/src/lib/mind/registry.js";
import {
  deliveryQueue,
  mindHistory,
  systemEvents,
  users,
} from "../packages/daemon/src/lib/schema.js";

// --- Harness (mirrors test/delivery-hold.test.ts) ---

type MindEnvelope = {
  content?: unknown;
  batch?: { channels?: Record<string, { content?: unknown; deferred?: unknown }[]> };
};

async function startMindServer(status = 200): Promise<{
  server: Server;
  port: number;
  received: MindEnvelope[];
}> {
  const received: MindEnvelope[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      received.push(JSON.parse(raw));
      res.writeHead(status, { "Content-Type": "application/json" }).end("{}");
    });
  });
  const port: number = await new Promise((r) => {
    server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port));
  });
  return { server, port, received };
}

async function registerMind(port: number, config: RoutingConfig | object): Promise<string> {
  const name = `gate-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await addMind(name, port);
  const configDir = resolve(process.env.VOLUTE_HOME!, "minds", name, "home/.config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(resolve(configDir, "routes.json"), JSON.stringify(config));
  return name;
}

async function queueRows(mind: string, status: string) {
  const db = await getDb();
  return db
    .select()
    .from(deliveryQueue)
    .where(and(eq(deliveryQueue.mind, mind), eq(deliveryQueue.status, status)));
}

async function allQueueRows(mind: string) {
  const db = await getDb();
  return db.select().from(deliveryQueue).where(eq(deliveryQueue.mind, mind));
}

async function inbound(mind: string) {
  const db = await getDb();
  return db
    .select()
    .from(mindHistory)
    .where(and(eq(mindHistory.mind, mind), eq(mindHistory.type, "inbound")))
    .orderBy(mindHistory.id);
}

async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor timed out");
}

/** Make every deferred row on a mind due now, as if its deadline had passed. */
async function makeDeferredDue(mind: string): Promise<void> {
  const db = await getDb();
  await db
    .update(deliveryQueue)
    .set({ next_attempt_at: sql`datetime('now', '-1 seconds')` })
    .where(and(eq(deliveryQueue.mind, mind), eq(deliveryQueue.status, "deferred")));
}

function texts(body: MindEnvelope): string[] {
  const out: string[] = [];
  if (body.content !== undefined) out.push(String(body.content));
  for (const msgs of Object.values(body.batch?.channels ?? {})) {
    for (const m of msgs) out.push(String(m.content));
  }
  return out;
}

function msg(channel: string, content: string, sender = "alice"): DeliveryPayload {
  return { channel, sender, senderId: null, content };
}

const QUIET: RoutingConfig = {
  rules: [{ channel: "#quiet", thread: "shared" }],
  threads: { shared: { delivery: "defer" } },
  gateUnmatched: false,
};

describe("delivery: defer", () => {
  let manager: DeliveryManager;
  const servers: Server[] = [];
  const minds: string[] = [];

  afterEach(async () => {
    manager?.dispose();
    clearConfigCache();
    for (const s of servers.splice(0)) s.close();
    for (const m of minds.splice(0)) {
      releaseTurnSlot(m);
      await removeMind(m);
    }
  });

  async function setup(config: RoutingConfig | object, status = 200) {
    const srv = await startMindServer(status);
    servers.push(srv.server);
    const name = await registerMind(srv.port, config);
    minds.push(name);
    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);
    return { srv, name };
  }

  it("resolves defer, with and without maxWait", () => {
    const cfg: RoutingConfig = {
      threads: { a: { delivery: "defer" }, b: { delivery: { mode: "defer", maxWait: 600 } } },
    };
    assert.deepEqual(resolveDeliveryMode(cfg, "a").delivery, { mode: "defer" });
    assert.deepEqual(resolveDeliveryMode(cfg, "b").delivery, { mode: "defer", maxWait: 600 });
  });

  it("keeps a deferred message without waking the mind, and never lets the sweep send it", async () => {
    const { srv, name } = await setup(QUIET);
    const r = await manager.routeAndDeliver(name, msg("#quiet", "just chatting"));
    assert.equal(r.routed && r.mode, "deferred");

    await manager.redrive();
    await manager.redrive();
    assert.equal(srv.received.length, 0, "no POST: nothing woke the mind");
    const rows = await queueRows(name, "deferred");
    assert.equal(rows.length, 1, "the message is kept");
    assert.equal(rows[0].next_attempt_at, null, "with no deadline, it waits for a turn");
  });

  it("rides along with the next turn on its thread, oldest first, marked as having waited", async () => {
    const { srv, name } = await setup({
      rules: [
        { channel: "#quiet", thread: "main" },
        { channel: "@*", thread: "main", isDM: true },
      ],
      threads: { main: { delivery: "defer" } },
      gateUnmatched: false,
    });
    await manager.routeAndDeliver(name, msg("#quiet", "first"));
    await manager.routeAndDeliver(name, msg("#quiet", "second"));
    assert.equal(srv.received.length, 0);

    // A delivery to the same thread that isn't deferred — an explicit-session send.
    await manager.routeAndDeliver(name, { ...msg("@bob", "wake up", "bob"), session: "main" });

    assert.equal(srv.received.length, 1, "one POST carries all three");
    const got = texts(srv.received[0]);
    assert.equal(got.length, 3);
    assert.match(got[0], /^\[deferred — this arrived at .*\]\nfirst$/);
    assert.match(got[1], /second$/);
    assert.equal(got[2], "wake up", "the trigger comes last and unannotated");
    for (const msgs of Object.values(srv.received[0].batch?.channels ?? {})) {
      for (const m of msgs)
        assert.equal(m.deferred, undefined, "the marker never reaches the mind");
    }
    assert.equal((await allQueueRows(name)).length, 0, "every row is settled on ack");
  });

  it("flushes on its own at maxWait, as one batched turn", async () => {
    const { srv, name } = await setup({
      rules: [{ channel: "#quiet", thread: "q" }],
      threads: { q: { delivery: { mode: "defer", maxWait: 600 } } },
      gateUnmatched: false,
    });
    await manager.routeAndDeliver(name, msg("#quiet", "one"));
    await manager.routeAndDeliver(name, msg("#quiet", "two"));
    const [row] = await queueRows(name, "deferred");
    assert.ok(row.next_attempt_at, "the deadline is recorded on the row, so it survives a restart");

    await manager.redrive();
    assert.equal(srv.received.length, 0, "not before the deadline");

    await makeDeferredDue(name);
    await manager.redrive();
    await waitFor(() => srv.received.length === 1);
    assert.deepEqual(
      texts(srv.received[0]).map((t) => t.split("\n").pop()),
      ["one", "two"],
    );
    await waitFor(async () => (await allQueueRows(name)).length === 0);
  });

  it("waits out a mind that isn't running rather than flushing into nothing", async () => {
    const { srv, name } = await setup({
      rules: [{ channel: "#quiet", thread: "q" }],
      threads: { q: { delivery: { mode: "defer", maxWait: 1 } } },
      gateUnmatched: false,
    });
    await manager.routeAndDeliver(name, msg("#quiet", "one"));
    await makeDeferredDue(name);
    manager.setRunningCheck(() => false); // asleep, or stopped
    await manager.redrive();
    assert.equal(srv.received.length, 0);
    assert.equal((await queueRows(name, "deferred")).length, 1, "still kept");

    manager.setRunningCheck(() => true); // woke up
    await manager.redrive();
    await waitFor(() => srv.received.length === 1);
  });

  it("leaves riders deferred when the POST they rode on is rejected, counting the rejection", async () => {
    const { srv, name } = await setup(
      {
        rules: [{ channel: "#quiet", thread: "main" }],
        threads: { main: { delivery: "defer" } },
        gateUnmatched: false,
      },
      500,
    );
    await manager.routeAndDeliver(name, msg("#quiet", "waiting"));
    await manager.routeAndDeliver(name, { ...msg("@bob", "hello", "bob"), session: "main" });
    assert.equal(srv.received.length, 1);

    const deferred = await queueRows(name, "deferred");
    assert.equal(deferred.length, 1, "the rider is still deferred");
    assert.equal(deferred[0].attempts, 1, "the rejection may have been its doing, so it counts");
    assert.equal(deferred[0].next_attempt_at, null, "and its deadline is left alone");
    const pending = await queueRows(name, "pending");
    assert.equal(pending.length, 1, "the trigger is retried as usual");
    assert.equal(pending[0].attempts, 1);
  });

  it("dead-letters a poison rider at the attempt ceiling, so it can't sink its thread", async () => {
    const { name } = await setup(
      {
        rules: [{ channel: "#quiet", thread: "main" }],
        threads: { main: { delivery: "defer" } },
        gateUnmatched: false,
      },
      500,
    );
    const notices: unknown[] = [];
    manager.setFailureNotifier(async (n) => {
      notices.push(n);
    });
    await manager.routeAndDeliver(name, msg("#quiet", "poison"));
    const db = await getDb();
    await db
      .update(deliveryQueue)
      .set({ attempts: MAX_DELIVERY_ATTEMPTS - 1 })
      .where(and(eq(deliveryQueue.mind, name), eq(deliveryQueue.status, "deferred")));
    await manager.flushDeferred(name, "main");

    assert.equal((await queueRows(name, "deferred")).length, 0);
    assert.equal((await queueRows(name, "dead")).length, 1, "terminal, like any other row (#356)");
    assert.equal(notices.length, 1, "and the mind is told");
  });

  it("dead-letters an unparseable deferred row instead of skipping it forever", async () => {
    const { srv, name } = await setup(QUIET);
    await manager.routeAndDeliver(name, msg("#quiet", "fine"));
    const db = await getDb();
    await db.insert(deliveryQueue).values({
      mind: name,
      target_mind: name,
      thread: "shared",
      status: "deferred",
      payload: "{not json",
    });
    assert.equal(await manager.flushDeferred(name, "shared"), true);
    assert.equal(srv.received.length, 1);
    assert.equal(texts(srv.received[0]).length, 1, "the good one still goes");
    assert.equal((await queueRows(name, "dead")).length, 1);
    assert.equal((await queueRows(name, "deferred")).length, 0);
  });

  it("delivers now, rather than losing it, when a deferred message can't be saved", async () => {
    const { srv, name } = await setup(QUIET);
    const real = (manager as any).persistToQueue.bind(manager);
    (manager as any).persistToQueue = (m: string, t: string, p: DeliveryPayload, st?: string) =>
      st === "deferred" ? Promise.resolve(undefined) : real(m, t, p, st);
    const r = await manager.routeAndDeliver(name, msg("#quiet", "don't lose me"));
    assert.equal(r.routed && r.mode, "immediate");
    assert.equal(srv.received.length, 1);
    assert.equal(texts(srv.received[0])[0], "don't lose me", "not marked as having waited");
  });

  it("gives back its turn slot and rows if preparing a batch throws", async () => {
    const { name } = await setup(QUIET);
    await manager.routeAndDeliver(name, msg("#quiet", "hi"));
    (manager as any).enrichWithProfiles = async () => {
      throw new Error("boom");
    };
    assert.equal(await manager.flushDeferred(name, "shared"), false);
    assert.equal(hasTurnSlot(name, "shared"), false, "the turn slot is given back");
    assert.equal((manager as any).inFlight.size, 0, "and the rows aren't left owned");
    assert.equal((await queueRows(name, "deferred")).length, 1, "still kept");
  });

  it("counts maxWait from arrival: a deferral that expired overnight goes out after waking", async () => {
    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, {
      rules: [{ channel: "#quiet", thread: "q" }],
      threads: { q: { delivery: { mode: "defer", maxWait: 600 } } },
      gateUnmatched: false,
    });
    minds.push(name);
    const global = initDeliveryManager();
    global.setRunningCheck(() => true);
    try {
      const overnight = {
        ...msg("#quiet", "at midnight"),
        deferred: { at: Date.now() - 8 * 3600_000 },
      };
      assert.equal(await deliverBatch(name, [overnight]), true);
      assert.equal(srv.received.length, 0, "the wake flush doesn't carry it on its own");
      await global.redrive();
      await waitFor(() => srv.received.length === 1);
      assert.match(texts(srv.received[0])[0], /at midnight$/);
    } finally {
      global.dispose();
    }
  });

  it("the wake flush reports failure when a deferred message can't be saved, so the sleep queue keeps it", async () => {
    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, QUIET);
    minds.push(name);
    const global = initDeliveryManager();
    (global as any).persistToQueue = () => Promise.resolve(undefined);
    try {
      assert.equal(await deliverBatch(name, [msg("#quiet", "keep me")]), false);
      assert.equal(srv.received.length, 0);
    } finally {
      global.dispose();
    }
  });

  it("backs off a due rider the mind rejected, instead of re-offering it every sweep", async () => {
    const { name } = await setup(
      {
        rules: [{ channel: "#quiet", thread: "q" }],
        threads: { q: { delivery: { mode: "defer", maxWait: 600 } } },
        gateUnmatched: false,
      },
      500,
    );
    await manager.routeAndDeliver(name, msg("#quiet", "hi"));
    await makeDeferredDue(name);
    await manager.flushDeferred(name, "q");
    const [row] = await queueRows(name, "deferred");
    assert.equal(row.attempts, 1);
    const due = new Date(`${row.next_attempt_at!.replace(" ", "T")}Z`).getTime();
    assert.ok(due > Date.now(), "its deadline moved past now, by the backoff");
  });

  it("carries no riders on a retry, so a message the mind rejects can't sink them", async () => {
    const { srv, name } = await setup(QUIET);
    await manager.routeAndDeliver(name, msg("#quiet", "waiting"));
    const db = await getDb();
    await db.insert(deliveryQueue).values({
      mind: name,
      target_mind: name,
      thread: "shared",
      status: "pending",
      attempts: 2,
      payload: JSON.stringify({ ...msg("@bob", "retry me", "bob"), session: "shared" }),
    });
    await manager.redrive();
    await waitFor(() => srv.received.length === 1);
    assert.deepEqual(texts(srv.received[0]), ["retry me"]);
    assert.equal((await queueRows(name, "deferred")).length, 1, "the rider waits for a fresh turn");
  });

  it("doesn't let riders slip past a spend hold with a message that has no row", async () => {
    const { srv, name } = await setup(QUIET);
    await manager.routeAndDeliver(name, msg("#quiet", "waiting"));
    manager.setHoldCheck(() => ({ reason: "spend_cap", scope: "mind" }));
    (manager as any).persistToQueue = () => Promise.resolve(undefined);
    await manager.routeAndDeliver(name, { ...msg("@bob", "no row", "bob"), session: "shared" });
    assert.equal(srv.received.length, 1, "the unsaved message still goes, rather than be lost");
    assert.deepEqual(texts(srv.received[0]), ["no row"], "alone");
    assert.equal((await queueRows(name, "deferred")).length, 1, "the rider keeps waiting");
    assert.equal((manager as any).inFlight.size, 0);
  });

  it("gives back the turn slot if preparing an immediate delivery throws", async () => {
    const { name } = await setup({
      rules: [{ channel: "*", thread: "main" }],
      gateUnmatched: false,
    });
    (manager as any).enrichWithProfiles = async () => {
      throw new Error("boom");
    };
    await manager.routeAndDeliver(name, msg("#x", "hi"));
    assert.equal(hasTurnSlot(name, "main"), false);
    assert.equal((manager as any).inFlight.size, 0);
    assert.equal((await queueRows(name, "pending")).length, 1, "kept for the sweep");
  });

  it("gives back the wake flush's turn slot if claiming riders throws", async () => {
    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, QUIET);
    minds.push(name);
    const global = initDeliveryManager();
    (global as any).claimDeferred = async () => {
      throw new Error("boom");
    };
    try {
      assert.equal(
        await deliverBatch(name, [{ ...msg("@bob", "hi", "bob"), session: "x" }]),
        false,
      );
      assert.equal(hasTurnSlot(name, "x"), false);
    } finally {
      global.dispose();
    }
  });

  it("tells the mind a defer thread with no maxWait only hears what else wakes it", () => {
    const problems = routesConfigProblems({
      threads: { a: { delivery: "defer" }, b: { delivery: { mode: "defer", maxWait: 60 } } },
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /threads\["a"\].*wait until something else wakes this thread/);
  });

  it("records a deferred message in history only when it reaches the mind, at its arrival time (#420)", async () => {
    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, {
      rules: [
        { channel: "#quiet", thread: "main" },
        { channel: "@*", thread: "main" },
      ],
      threads: { main: { delivery: "defer" } },
      gateUnmatched: false,
    });
    minds.push(name);
    const global = initDeliveryManager();
    global.setRunningCheck(() => true);
    try {
      await deliverMessage(name, msg("#quiet", "said earlier"));
      assert.equal((await inbound(name)).length, 0, "not recorded while it waits");

      await global.flushDeferred(name, "main");
      await waitFor(async () => (await inbound(name)).length === 1);
      const [row] = await inbound(name);
      assert.equal(row.content, "said earlier");
      assert.equal(row.channel, "#quiet");
    } finally {
      global.dispose();
    }
  });

  it("rides along with a system-event turn on its thread", async () => {
    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, {
      rules: [{ channel: "#quiet", thread: "main" }],
      threads: { main: { delivery: "defer" } },
      gateUnmatched: false,
    });
    minds.push(name);
    const global = initDeliveryManager();
    global.setRunningCheck(() => true);
    try {
      await deliverMessage(name, msg("#quiet", "kept for later"));
      assert.equal(srv.received.length, 0);
      await deliverEvent(name, { type: "schedule", body: "tick", thread: "main" });
      await waitFor(() => srv.received.length === 2);
      // First, since it arrived first; the event folds into the turn it starts.
      assert.match(texts(srv.received[0])[0], /kept for later$/);
      assert.equal((srv.received[1] as { kind?: string }).kind, "event");
    } finally {
      global.dispose();
    }
  });

  it("carries deferred messages along with a system-event turn (flushDeferred)", async () => {
    const { srv, name } = await setup({
      rules: [{ channel: "#quiet", thread: "main" }],
      threads: { main: { delivery: "defer" } },
      gateUnmatched: false,
    });
    await manager.routeAndDeliver(name, msg("#quiet", "hi"));
    await manager.flushDeferred(name, "main");
    assert.equal(srv.received.length, 1);
    await manager.flushDeferred(name, "main");
    assert.equal(srv.received.length, 1, "with nothing deferred, flushing sends nothing");
  });
});

describe("mode: mention defers instead of dropping", () => {
  let manager: DeliveryManager;
  const servers: Server[] = [];
  const minds: string[] = [];

  afterEach(async () => {
    manager?.dispose();
    clearConfigCache();
    for (const s of servers.splice(0)) s.close();
    for (const m of minds.splice(0)) {
      releaseTurnSlot(m);
      await removeMind(m);
    }
  });

  const MENTION = {
    rules: [{ channel: "#busy", thread: "busy", mode: "mention" }],
    gateUnmatched: false,
  };

  it("keeps a non-mention and delivers it with the next mention", async () => {
    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, MENTION);
    minds.push(name);
    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);

    const r = await manager.routeAndDeliver(name, msg("#busy", "anyone around?"));
    assert.equal(r.routed && r.mode, "deferred");
    assert.equal(srv.received.length, 0);

    await manager.routeAndDeliver(name, msg("#busy", `hey ${name}, look`));
    assert.equal(srv.received.length, 1);
    const got = texts(srv.received[0]);
    assert.match(got[0], /anyone around\?$/);
    assert.equal(got[1], `hey ${name}, look`);
  });

  it("applies on the wake flush too: a backlog of only non-mentions doesn't wake a turn", async () => {
    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, MENTION);
    minds.push(name);
    const global = initDeliveryManager();
    global.setRunningCheck(() => true);
    try {
      const ok = await deliverBatch(name, [msg("#busy", "one"), msg("#busy", "two")]);
      assert.equal(ok, true, "handled — the sleep queue may let these rows go");
      assert.equal(srv.received.length, 0, "no turn for a backlog the mind asked not to wake for");
      assert.equal((await queueRows(name, "deferred")).length, 2, "kept as deferred instead");

      // A backlog with a mention in it goes, the non-mentions riding along.
      const ok2 = await deliverBatch(name, [msg("#busy", "three"), msg("#busy", `${name}?`)]);
      assert.equal(ok2, true);
      assert.equal(srv.received.length, 1, "one turn");
      // The ones deferred earlier come first, in the same envelope.
      const got = texts(srv.received[0]);
      assert.equal(got.length, 4);
      assert.match(got[0], /^\[deferred — .*\]\none$/);
      assert.match(got[1], /two$/);
      assert.deepEqual(got.slice(2), ["three", `${name}?`]);
      assert.equal((await queueRows(name, "deferred")).length, 0);
    } finally {
      global.dispose();
    }
  });

  it("across sleep: a non-mention queued while asleep isn't recorded, and is deferred at wake", async () => {
    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, MENTION);
    minds.push(name);
    const global = initDeliveryManager();
    global.setRunningCheck(() => true);
    const sm = getSleepManagerIfReady() ?? initSleepManager();
    const sleeper = sm as unknown as { isSleeping: (n: string) => boolean };
    const realIsSleeping = sm.isSleeping.bind(sm);
    sleeper.isSleeping = (n) => n === name;
    try {
      await deliverMessage(name, msg("#busy", "while you slept"));
      assert.equal((await queueRows(name, "sleep-queued")).length, 1);
      assert.equal((await inbound(name)).length, 0, "not recorded: it won't reach the mind yet");

      sleeper.isSleeping = realIsSleeping;
      await sm.flushQueuedMessages(name);
      assert.equal(srv.received.length, 0, "waking isn't a turn on this thread");
      assert.equal((await queueRows(name, "sleep-queued")).length, 0);
      assert.equal((await queueRows(name, "deferred")).length, 1, "kept as deferred");

      await global.flushDeferred(name, "busy");
      await waitFor(async () => (await inbound(name)).length === 1);
      assert.match(texts(srv.received[0])[0], /while you slept$/);
    } finally {
      sleeper.isSleeping = realIsSleeping;
      global.dispose();
    }
  });

  async function mentionNotices(mind: string) {
    const db = await getDb();
    return db
      .select()
      .from(systemEvents)
      .where(
        and(
          eq(systemEvents.mind, mind),
          sql`json_extract(${systemEvents.meta}, '$.reason') = 'routes_mention_defers'`,
        ),
      )
      .all();
  }

  it("tells a mind that already had a mention rule, once, however the rules then move", async () => {
    const mind = `mention-note-${process.pid}-${Date.now()}`;
    const rule = { channel: "#busy", thread: "busy", mode: "mention" } as const;
    await reportRoutesConfigProblems(mind, { rules: [rule] });
    await reportRoutesConfigProblems(mind, { rules: [rule] });
    // A rule inserted above it, then an edit to it: still the same news, already told.
    await reportRoutesConfigProblems(mind, { rules: [{ channel: "#x", thread: "x" }, rule] });
    await reportRoutesConfigProblems(mind, {
      rules: [
        { channel: "#x", thread: "x" },
        { ...rule, channel: "#busier" },
      ],
    });
    // A restarted daemon doesn't tell it again either.
    const restarted = await import(
      `../packages/daemon/src/lib/delivery/delivery-router.js?restart=${Date.now()}`
    );
    await restarted.reportRoutesConfigProblems(mind, { rules: [rule] });

    const notices = await mentionNotices(mind);
    assert.equal(notices.length, 1);
    assert.match(notices[0].body, /mode "mention"/);
    assert.match(notices[0].body, /used to be dropped/);
  });

  it("tells it once even when its ledger already held something else", async () => {
    const mind = `mention-ledger-${process.pid}-${Date.now()}`;
    // A ledger from before the change, naming a problem since fixed.
    mkdirSync(stateDir(mind), { recursive: true });
    writeFileSync(
      resolve(stateDir(mind), "routes-problems.json"),
      JSON.stringify({ "an old problem": Date.now() }),
    );
    const cfg: RoutingConfig = { rules: [{ channel: "#b", thread: "b", mode: "mention" }] };
    await reportRoutesConfigProblems(mind, cfg);
    await reportRoutesConfigProblems(mind, cfg);
    assert.equal((await mentionNotices(mind)).length, 1);
  });

  it("doesn't tell a mind that writes its first mention rule after the change", async () => {
    const mind = `mention-new-${process.pid}-${Date.now()}`;
    await reportRoutesConfigProblems(mind, { rules: [{ channel: "#a", thread: "a" }] });
    await reportRoutesConfigProblems(mind, {
      rules: [{ channel: "#a", thread: "a", mode: "mention" }],
    });
    assert.equal((await mentionNotices(mind)).length, 0);
  });
});

describe("rateLimit", () => {
  let manager: DeliveryManager;
  const servers: Server[] = [];
  const minds: string[] = [];

  afterEach(async () => {
    manager?.dispose();
    clearConfigCache();
    for (const s of servers.splice(0)) s.close();
    for (const m of minds.splice(0)) {
      releaseTurnSlot(m);
      await removeMind(m);
    }
  });

  it("defers wakes beyond the limit until the window frees one, and never drops them", async () => {
    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, {
      rules: [{ channel: "#chat", thread: "chat" }],
      threads: { chat: { rateLimit: { max: 1, windowMinutes: 60 } } },
      gateUnmatched: false,
    });
    minds.push(name);
    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);

    await manager.routeAndDeliver(name, msg("#chat", "one"));
    assert.equal(srv.received.length, 1, "the first wake is within the limit");

    // Mid-turn, a message folds into the running turn: no new wake, so no limit.
    await manager.routeAndDeliver(name, msg("#chat", "two"));
    assert.equal(srv.received.length, 2);

    manager.sessionDone(name, "chat");
    const r = await manager.routeAndDeliver(name, msg("#chat", "three"));
    assert.equal(r.routed && r.mode, "deferred", "the second wake in the window defers");
    assert.equal(srv.received.length, 2);
    const [row] = await queueRows(name, "deferred");
    const due = new Date(`${row.next_attempt_at!.replace(" ", "T")}Z`).getTime();
    assert.ok(due > Date.now() + 59 * 60_000, "it's due when the window frees a wake");

    // The window frees.
    (manager as unknown as { recentWakes: Map<string, number[]> }).recentWakes.clear();
    await makeDeferredDue(name);
    await manager.redrive();
    await waitFor(() => srv.received.length === 3);
    assert.match(texts(srv.received[2])[0], /three$/);
  });

  for (const failure of ["rejected", "unreachable"] as const) {
    it(`doesn't count a wake the mind never took (${failure})`, async () => {
      const srv = await startMindServer(500);
      servers.push(srv.server);
      let port = srv.port;
      if (failure === "unreachable") {
        await new Promise((r) => srv.server.close(r));
        port = srv.port;
      }
      const name = await registerMind(port, {
        rules: [{ channel: "#chat", thread: "chat" }],
        threads: { chat: { rateLimit: { max: 1, windowMinutes: 60 } } },
        gateUnmatched: false,
      });
      minds.push(name);
      manager = new DeliveryManager();
      manager.setRunningCheck(() => true);
      await manager.routeAndDeliver(name, msg("#chat", "one"));
      const r = await manager.routeAndDeliver(name, msg("#chat", "two"));
      assert.equal(r.routed && r.mode, "immediate", "the failed attempt didn't use the window");
    });
  }

  it("counts a wake-flush turn against the window", async () => {
    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, {
      rules: [{ channel: "#chat", thread: "chat" }],
      threads: { chat: { rateLimit: { max: 1, windowMinutes: 60 } } },
      gateUnmatched: false,
    });
    minds.push(name);
    const global = initDeliveryManager();
    global.setRunningCheck(() => true);
    try {
      assert.equal(await deliverBatch(name, [msg("#chat", "overnight")]), true);
      assert.equal(srv.received.length, 1);
      global.sessionDone(name, "chat");
      const r = await global.routeAndDeliver(name, msg("#chat", "morning"));
      assert.equal(r.routed && r.mode, "deferred", "the wake used the window's one wake");
    } finally {
      global.dispose();
    }
  });

  it("ignores, and reports, a max that allows no wakes at all", async () => {
    const cfg = { threads: { chat: { rateLimit: { max: 0.5, windowMinutes: 60 } } } };
    assert.equal(resolveDeliveryMode(cfg as RoutingConfig, "chat").rateLimit, undefined);
    const problems = routesConfigProblems(cfg as RoutingConfig);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /at least 1/);

    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, {
      rules: [{ channel: "#chat", thread: "chat" }],
      ...cfg,
      gateUnmatched: false,
    });
    minds.push(name);
    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);
    const r = await manager.routeAndDeliver(name, msg("#chat", "hi"));
    assert.equal(r.routed && r.mode, "immediate");
    assert.equal(srv.received.length, 1);
  });

  it("reports a malformed rateLimit", () => {
    const problems = routesConfigProblems({
      threads: { chat: { rateLimit: { max: 0 } } },
    } as RoutingConfig);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /rateLimit/);
  });
});

describe("senderKind", () => {
  async function user(username: string, user_type: string): Promise<number> {
    const db = await getDb();
    const [row] = await db
      .insert(users)
      .values({ username, password_hash: "!", role: "user", user_type: user_type as never })
      .returning({ id: users.id });
    return row.id;
  }

  it("classifies senders from the users table, bridge names, and self", async () => {
    const tag = `${process.pid}${Date.now()}`;
    const human = await user(`h${tag}`, "human");
    const mind = await user(`m${tag}`, "mind");
    const spirit = await user(`s${tag}`, "spirit");
    const puppet = await user(`discord:p${tag}`, "puppet");
    const base = `me${tag}`;

    assert.equal(await classifySender(base, `h${tag}`, human), "human");
    assert.equal(await classifySender(base, `m${tag}`, mind), "mind");
    assert.equal(await classifySender(base, `s${tag}`, spirit), "mind");
    assert.equal(await classifySender(base, `discord:p${tag}`, puppet), "bridge");
    assert.equal(await classifySender(base, "mail:a@b.c", null), "bridge");
    assert.equal(await classifySender(base, `m${tag}`, null), "mind", "unauthenticated, by name");
    assert.equal(await classifySender(base, base, null), "self");
    assert.equal(await classifySender(base, `nobody${tag}`, null), undefined);
  });

  it("matches rules by sender kind", async () => {
    const cfg: RoutingConfig = {
      rules: [
        { channel: "#c", senderKind: "mind", thread: "minds" },
        { channel: "#c", thread: "people" },
      ],
    };
    assert.equal(resolveRoute(cfg, { channel: "#c", senderKind: "mind" }).session, "minds");
    assert.equal(resolveRoute(cfg, { channel: "#c", senderKind: "human" }).session, "people");
    assert.equal(resolveRoute(cfg, { channel: "#c" }).session, "people", "unclassified");
  });

  it("routes through the daemon by the sender's kind", async () => {
    const tag = `${process.pid}${Date.now()}r`;
    const other = `m${tag}`;
    const otherId = await user(other, "mind");
    const name = await registerMind(4999, {
      rules: [
        { channel: "#c", senderKind: "mind", thread: "minds" },
        { channel: "#c", thread: "people" },
      ],
      gateUnmatched: false,
    });
    const manager = new DeliveryManager();
    try {
      const fromMind = await manager.routeAndDeliver(name, {
        ...msg("#c", "hi", other),
        senderId: otherId,
      });
      assert.equal(fromMind.routed && fromMind.session, "minds");
      const fromBridge = await manager.routeAndDeliver(name, msg("#c", "hi", "discord:x"));
      assert.equal(fromBridge.routed && fromBridge.session, "people");
    } finally {
      manager.dispose();
      clearConfigCache();
      releaseTurnSlot(name);
      await removeMind(name);
    }
  });

  it("warns about an unknown senderKind", () => {
    const problems = routesConfigProblems({
      rules: [{ channel: "#c", senderKind: "robot" as never, thread: "x" }],
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /senderKind "robot"/);
  });
});
