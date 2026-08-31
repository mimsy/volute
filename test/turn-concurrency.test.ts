import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  acquireTurnSlot,
  activeTurnCount,
  ageTurnSlotsForTest,
  concurrencyHold,
  releaseTurnSlot,
  resetTurnSlots,
  setTurnLimits,
  takeTurnSlot,
} from "../packages/daemon/src/lib/daemon/turn-slots.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  type DeliveryHold,
  DeliveryManager,
  initDeliveryManager,
  tryGetDeliveryManager,
} from "../packages/daemon/src/lib/delivery/delivery-manager.js";
import {
  clearConfigCache,
  type RoutingConfig,
} from "../packages/daemon/src/lib/delivery/delivery-router.js";
import {
  deliverBatch,
  willHoldMessage,
} from "../packages/daemon/src/lib/delivery/message-delivery.js";
import { addMind, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import { deliveryQueue } from "../packages/daemon/src/lib/schema.js";

// --- Helpers ---

async function startMindServer(
  status = 200,
): Promise<{ server: Server; port: number; received: unknown[] }> {
  const received: unknown[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      try {
        received.push(JSON.parse(raw));
      } catch {
        received.push(raw);
      }
      res.writeHead(status, { "Content-Type": "application/json" }).end("{}");
    });
  });
  const port: number = await new Promise((r) => {
    server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port));
  });
  return { server, port, received };
}

async function registerMind(port: number, config: RoutingConfig | object): Promise<string> {
  const name = `conc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await addMind(name, port);
  const configDir = resolve(process.env.VOLUTE_HOME!, "minds", name, "home/.config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(resolve(configDir, "routes.json"), JSON.stringify(config));
  return name;
}

async function queueRows(mind: string, status = "pending") {
  const db = await getDb();
  return db
    .select()
    .from(deliveryQueue)
    .where(and(eq(deliveryQueue.mind, mind), eq(deliveryQueue.status, status)));
}

async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timed out");
}

const IMMEDIATE: RoutingConfig = {
  rules: [{ channel: "*", thread: "main" }],
  gateUnmatched: false,
};

const MOMENTARY: DeliveryHold = { reason: "mind_concurrency", scope: "mind", momentary: true };
const SPEND_HOLD: DeliveryHold = { reason: "spend_cap", scope: "mind" };

// --- The gate itself ---

describe("turn slots: the concurrency gate (#823)", () => {
  beforeEach(() => resetTurnSlots());
  afterEach(() => resetTurnSlots());

  it("lets a delivery into a session that is already mid-turn", () => {
    // It folds into the running turn through the streaming input channel — no second
    // subprocess, no added concurrency. This is also why interrupts pass without the
    // resolver ever being told which deliveries are interrupts.
    acquireTurnSlot("mimsy", "main");
    assert.equal(concurrencyHold("mimsy", "main"), null);
  });

  it("holds a second session of the same mind", () => {
    acquireTurnSlot("mimsy", "main");
    const hold = concurrencyHold("mimsy", "discord");
    assert.equal(hold?.reason, "mind_concurrency");
    assert.equal(hold?.scope, "mind");
  });

  it("lifts the per-mind hold when the turn ends", () => {
    acquireTurnSlot("mimsy", "main");
    assert.ok(concurrencyHold("mimsy", "discord"));
    releaseTurnSlot("mimsy", "main");
    assert.equal(concurrencyHold("mimsy", "discord"), null);
  });

  it("holds at the global cap, across minds", () => {
    setTurnLimits({ globalConcurrentTurns: 2 });
    acquireTurnSlot("mimsy", "main");
    acquireTurnSlot("whorl", "main");
    const hold = concurrencyHold("pip", "main");
    assert.equal(hold?.reason, "turn_concurrency");
    assert.equal(hold?.scope, "system", "the global cap is the install's problem, not a mind's");
    releaseTurnSlot("whorl", "main");
    assert.equal(concurrencyHold("pip", "main"), null);
  });

  it("is unlimited globally when no global cap is set", () => {
    for (const m of ["a", "b", "c", "d", "e"]) acquireTurnSlot(m, "main");
    assert.equal(concurrencyHold("f", "main"), null);
    assert.equal(activeTurnCount(), 5);
  });

  it("honours a raised per-mind cap", () => {
    setTurnLimits({ mindConcurrentTurns: 2 });
    acquireTurnSlot("mimsy", "main");
    assert.equal(concurrencyHold("mimsy", "discord"), null);
    acquireTurnSlot("mimsy", "discord");
    assert.ok(concurrencyHold("mimsy", "third"));
  });

  it("expires a slot the mind never reported done, rather than gating it forever", () => {
    // A mind that dies mid-turn emits no `done`. Left alone that slot would make it
    // permanently deaf — the one failure this gate must never produce.
    acquireTurnSlot("mimsy", "main");
    assert.ok(concurrencyHold("mimsy", "discord"));
    ageTurnSlotsForTest(31 * 60_000);
    assert.equal(concurrencyHold("mimsy", "discord"), null);
    assert.equal(activeTurnCount(), 0);
  });

  it("takes a slot without waiting when there is capacity", async () => {
    const got = await takeTurnSlot("mimsy", "main");
    assert.equal(got.timedOut, false);
    assert.equal(got.waitedMs, 0);
    assert.equal(activeTurnCount(), 1);
  });

  it("serializes three simultaneous events for one mind, in arrival order", async () => {
    // The incident: three schedules fired in the same second and three SDK sessions
    // wrote concurrently. Each waits for the one before it now.
    const order: string[] = [];
    const runs = ["a", "b", "c"].map(async (id) => {
      await takeTurnSlot("mimsy", `session-${id}`);
      order.push(id);
    });
    // Give each `takeTurnSlot` a tick to either take the slot or queue behind the others.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(order.length, 1, "only one turn runs at a time");
    assert.equal(activeTurnCount(), 1);

    releaseTurnSlot("mimsy", "session-a");
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(order, ["a", "b"], "the longest waiter goes next");

    releaseTurnSlot("mimsy", "session-b");
    await Promise.all(runs);
    assert.deepEqual(order, ["a", "b", "c"]);
  });

  it("delivers anyway when the wait times out, and says so", async () => {
    // Fail open. Under the storage starvation that motivated #823 a turn can outlast any
    // bound we pick, and a schedule that never fires is worse than one that overlaps.
    acquireTurnSlot("mimsy", "main");
    const got = await takeTurnSlot("mimsy", "other", { timeoutMs: 30 });
    assert.equal(got.timedOut, true);
    assert.equal(activeTurnCount(), 2, "the overlapping turn is still accounted for");
  });

  it("skips the wait entirely for a forced delivery, but still takes a slot", async () => {
    acquireTurnSlot("mimsy", "main");
    const got = await takeTurnSlot("mimsy", "other", { wait: false });
    assert.equal(got.timedOut, false);
    assert.equal(got.waitedMs, 0);
    assert.equal(activeTurnCount(), 2);
  });

  it("tells a caller whether it started the turn or folded into one", () => {
    // The whole basis of the failure paths: a caller that folded in must not give back a
    // slot belonging to a turn that is still running.
    const first = acquireTurnSlot("mimsy", "main");
    const second = acquireTurnSlot("mimsy", "main");
    assert.equal(first, true, "the first delivery starts the turn");
    assert.equal(second, false, "the second folds into it and owns nothing");
  });

  it("a failed delivery that folded into a running turn leaves that turn's slot alone", async () => {
    // Releasing unconditionally here opened the gate mid-turn — and POSTs fail most under
    // load (the event envelope carries a 10s timeout), which is exactly when the gate has
    // to hold. The gate would have disabled itself under the conditions it exists for.
    acquireTurnSlot("mimsy", "main");
    const slot = await takeTurnSlot("mimsy", "main");
    assert.equal(slot.owned, false, "it folded into the running turn");

    // What every failure path now does.
    if (slot.owned) releaseTurnSlot("mimsy", "main");
    assert.equal(activeTurnCount(), 1, "the running turn keeps its slot");
    assert.ok(concurrencyHold("mimsy", "discord"), "and the gate still holds");
  });

  it("a failed delivery that DID start the turn gives its slot back", async () => {
    const slot = await takeTurnSlot("mimsy", "main");
    assert.equal(slot.owned, true);
    if (slot.owned) releaseTurnSlot("mimsy", "main");
    assert.equal(activeTurnCount(), 0, "an unreachable mind must not gate itself out");
  });

  it("frees every slot a stopped mind held", () => {
    acquireTurnSlot("mimsy", "main");
    acquireTurnSlot("mimsy", "discord");
    releaseTurnSlot("mimsy");
    assert.equal(activeTurnCount(), 0);
  });
});

// --- How the delivery queue stores a momentary hold ---

describe("DeliveryManager: a momentary hold is not a spend park", () => {
  let manager: DeliveryManager;
  const servers: Server[] = [];

  beforeEach(() => resetTurnSlots());
  afterEach(() => {
    manager?.dispose();
    clearConfigCache();
    resetTurnSlots();
    for (const s of servers.splice(0)) s.close();
  });

  it("leaves the row pending with attempts untouched — never `held`", async () => {
    // `held` is a deliberate, bounded release path worded for a spend cap. A hold that
    // lifts in seconds must not enter it, or a momentary wait would need a spend reset
    // to end and arrive with a summary about a cap that was never reached.
    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, IMMEDIATE);

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);
    manager.setHoldCheck(() => MOMENTARY);

    await manager.routeAndDeliver(name, { channel: "#c", sender: "alice", content: "hi" });

    assert.equal(srv.received.length, 0, "a mind mid-turn is not POSTed to");
    assert.equal((await queueRows(name, "held")).length, 0, "and the row does not become `held`");
    const pending = await queueRows(name, "pending");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].attempts, 0, "a hold is a scheduling decision, not a failure");
    assert.equal(pending[0].next_attempt_at, null, "and carries no backoff");
    await removeMind(name);
  });

  it("keeps the row pending across a redrive sweep, then delivers when the turn ends", async () => {
    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, IMMEDIATE);

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);
    let hold: DeliveryHold | null = MOMENTARY;
    manager.setHoldCheck(() => hold);

    await manager.routeAndDeliver(name, { channel: "#c", sender: "alice", content: "hi" });
    await manager.redrive();
    assert.equal(srv.received.length, 0);
    assert.equal((await queueRows(name, "held")).length, 0, "the sweep must not park it either");
    assert.equal((await queueRows(name, "pending")).length, 1);

    hold = null;
    await manager.redrive();
    // Wait on the row, not the POST: the stub records the request before it responds, so
    // `received` fills a beat before `deliverToMind` acks and deletes the row.
    await waitFor(async () => (await queueRows(name, "pending")).length === 0);
    assert.equal(srv.received.length, 1, "delivered once the hold lifted");
    await removeMind(name);
  });

  it("sweeps as soon as a turn ends, instead of waiting out the 15s sweep interval", async () => {
    // Without this the gate would add up to REDRIVE_INTERVAL_MS of dead air to every
    // handoff, which is most of the latency a mind's correspondent would ever feel.
    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, IMMEDIATE);

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);
    let hold: DeliveryHold | null = MOMENTARY;
    manager.setHoldCheck(() => hold);

    await manager.routeAndDeliver(name, { channel: "#c", sender: "alice", content: "hi" });
    assert.equal(srv.received.length, 0);

    hold = null;
    manager.sessionDone(name, "main");
    await waitFor(() => srv.received.length === 1, 2000);
    await removeMind(name);
  });

  it("a sweep requested during an in-flight sweep still gets its own pass", async () => {
    // `sessionDone` kicks a redrive so a released row goes out at the handoff instead of
    // waiting out REDRIVE_INTERVAL_MS. Coalescing alone would have broken that promise:
    // joining a sweep that already snapshotted its rows is not the same as being swept,
    // so a turn ending mid-sweep would have waited the full 15s anyway.
    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, IMMEDIATE);

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);
    manager.setHoldCheck(() => MOMENTARY); // leaves a pending row without POSTing
    await manager.routeAndDeliver(name, { channel: "#c", sender: "alice", content: "hi" });
    assert.equal((await queueRows(name, "pending")).length, 1);

    let sweeps = 0;
    // Called once per row per sweep; the mind now reads as down, so nothing is delivered
    // and the row survives to be counted again on the next pass.
    manager.setRunningCheck(() => {
      sweeps++;
      return false;
    });
    const first = manager.redrive();
    const second = manager.redrive(); // arrives while the first is still in flight
    await Promise.all([first, second]);
    assert.equal(sweeps, 2, "the second request gets a pass that re-reads the row");
    await removeMind(name);
  });

  it("a rejected delivery does not free the slot of the turn it folded into", async () => {
    // The same ownership rule as the event path, in the third place that releases on
    // failure. A mind rejecting one message has not stopped working on the turn that
    // message joined.
    const srv = await startMindServer(500);
    servers.push(srv.server);
    const name = await registerMind(srv.port, IMMEDIATE);

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);
    manager.setHoldCheck(() => null);
    acquireTurnSlot(name, "main"); // a turn is already running in this session

    await manager.routeAndDeliver(name, { channel: "#c", sender: "alice", content: "hi" });
    await waitFor(() => srv.received.length === 1);
    assert.equal(activeTurnCount(), 1, "the running turn keeps its slot");
    await removeMind(name);
  });

  it("a rejected wake-flush batch does not free the slot it folded into", async () => {
    // Third and last of the failure paths that release a slot. deliverBatch is the wake
    // flush's door; same rule, same reason.
    const srv = await startMindServer(500);
    servers.push(srv.server);
    const name = await registerMind(srv.port, IMMEDIATE);
    acquireTurnSlot(name, "main");
    try {
      const ok = await deliverBatch(name, [{ channel: "#c", sender: "alice", content: "hi" }]);
      assert.equal(ok, false, "the mind rejected the batch");
      assert.equal(activeTurnCount(), 1, "the running turn keeps its slot");
    } finally {
      await removeMind(name);
    }
  });

  it("does not block releaseHeld — a spend release must not wait on a busy mind", async () => {
    // `releaseHeld` returns early when the mind is still held. Reading a momentary hold
    // as "still capped" would silently no-op every release that happened to land while
    // the mind was mid-turn, and nothing retries it.
    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, IMMEDIATE);

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);
    manager.setHoldCheck(() => SPEND_HOLD);
    await manager.routeAndDeliver(name, { channel: "#c", sender: "alice", content: "waited" });
    assert.equal((await queueRows(name, "held")).length, 1);

    manager.setHoldCheck(() => MOMENTARY);
    const { released } = await manager.releaseHeld(name);
    assert.equal(released, 1, "the spend cap lifted, so the backlog is released");
    assert.equal((await queueRows(name, "pending")).length, 1);
    await removeMind(name);
  });
});

describe("willHoldMessage: a momentary hold does not defer the history row", () => {
  afterEach(() => {
    tryGetDeliveryManager()?.setHoldCheck(() => null);
  });

  it("is false while a mind is merely mid-turn, true under a spend cap", () => {
    // A mind mid-turn receives what arrives seconds later, so deferring its `mind_history`
    // row would move every message's recorded arrival time for a wait nobody can see.
    const dm = tryGetDeliveryManager() ?? initDeliveryManager();
    dm.setHoldCheck(() => MOMENTARY);
    assert.equal(willHoldMessage("mimsy"), false);
    dm.setHoldCheck(() => SPEND_HOLD);
    assert.equal(willHoldMessage("mimsy"), true);
  });
});
