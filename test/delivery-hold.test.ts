import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  type DeliveryHold,
  DeliveryManager,
  withHeldPreface,
} from "../packages/daemon/src/lib/delivery/delivery-manager.js";
import {
  clearConfigCache,
  type DeliveryPayload,
  type RoutingConfig,
} from "../packages/daemon/src/lib/delivery/delivery-router.js";
import { addMind, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import { deliveryQueue, mindHistory } from "../packages/daemon/src/lib/schema.js";
import { parseDbTimestamp } from "../packages/daemon/src/lib/util/time.js";

// --- Helpers (mirrors test/delivery-durability.test.ts) ---

async function startMindServer(delayMs = 0): Promise<{
  server: Server;
  port: number;
  received: MindEnvelope[];
  /** Resolves as soon as a POST arrives, before the (optionally delayed) response. */
  firstRequest: Promise<void>;
}> {
  const received: MindEnvelope[] = [];
  let signalFirst: () => void = () => {};
  const firstRequest = new Promise<void>((r) => {
    signalFirst = r;
  });
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      signalFirst();
      const respond = () => {
        try {
          received.push(JSON.parse(raw));
        } catch {
          received.push({ content: raw });
        }
        res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
      };
      if (delayMs > 0) setTimeout(respond, delayMs);
      else respond();
    });
  });
  const port: number = await new Promise((r) => {
    server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port));
  });
  return { server, port, received, firstRequest };
}

async function registerMind(port: number, config: RoutingConfig | object): Promise<string> {
  const name = `hold-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor timed out");
}

type MindEnvelope = {
  content?: unknown;
  batch?: { channels?: Record<string, { content?: unknown }[]> };
};

/** Text the mind actually received, across both the immediate and batch envelope shapes. */
function receivedText(body: MindEnvelope): string {
  const parts: unknown[] = [];
  if (body.content !== undefined) parts.push(body.content);
  for (const msgs of Object.values(body.batch?.channels ?? {})) {
    for (const m of msgs) parts.push(m.content);
  }
  return parts
    .flatMap((c) =>
      typeof c === "string"
        ? [c]
        : Array.isArray(c)
          ? c.map((b) => (b as { text?: string }).text ?? "")
          : [JSON.stringify(c)],
    )
    .join("\n");
}

const IMMEDIATE: RoutingConfig = {
  rules: [{ channel: "*", thread: "main" }],
  gateUnmatched: false,
};

const BATCH = {
  rules: [{ channel: "test:*", thread: "group" }],
  threads: { group: { delivery: { mode: "batch", debounce: 0, maxWait: 0 } } },
  gateUnmatched: false,
};

const SPEND_HOLD: DeliveryHold = { reason: "spend_cap", scope: "mind" };

describe("DeliveryManager: holding deliveries", () => {
  let manager: DeliveryManager;
  const servers: Server[] = [];

  afterEach(() => {
    manager?.dispose();
    clearConfigCache();
    for (const s of servers.splice(0)) s.close();
  });

  it("holds the POST and leaves the row pending, untouched", async () => {
    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, IMMEDIATE);

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);
    manager.setHoldCheck(() => SPEND_HOLD);

    await manager.routeAndDeliver(name, { channel: "test:ch", sender: "alice", content: "hi" });

    assert.equal(srv.received.length, 0, "a held mind is not POSTed to");
    assert.equal((await queueRows(name, "pending")).length, 0, "and it leaves the sweep");
    const rows = await queueRows(name, "held");
    assert.equal(rows.length, 1, "the message is kept, not dropped");
    // A hold is a scheduling decision, not a delivery failure: nothing here may look like
    // one, or a long hold would walk the row into the dead-letter ceiling.
    assert.equal(rows[0].attempts, 0, "a hold does not count as an attempt");
    assert.equal(rows[0].next_attempt_at, null, "and schedules no retry");

    await removeMind(name);
  });

  it("delivers normally when nothing is holding, with no preface", async () => {
    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, IMMEDIATE);

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);
    manager.setHoldCheck(() => null);

    await manager.routeAndDeliver(name, { channel: "test:ch", sender: "alice", content: "hi" });

    assert.equal(srv.received.length, 1);
    assert.equal(receivedText(srv.received[0]), "hi", "an unheld message is not annotated");
    assert.equal((await queueRows(name)).length, 0);

    await removeMind(name);
  });

  it("releases held messages on redrive, framed as having waited", async () => {
    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, IMMEDIATE);

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);
    let held: DeliveryHold | null = SPEND_HOLD;
    manager.setHoldCheck(() => held);

    await manager.routeAndDeliver(name, { channel: "test:ch", sender: "alice", content: "hi" });
    assert.equal(srv.received.length, 0);

    // The period rolls over.
    held = null;
    await manager.releaseHeld(name);
    await waitFor(async () => (await queueRows(name)).length === 0);

    assert.equal(srv.received.length, 1, "the held message is delivered, not lost");
    const text = receivedText(srv.received[0]);
    assert.match(text, /^\[held —/, "arrives prefaced rather than as new traffic");
    assert.match(text, /your spend cap/, "names why it waited");
    assert.match(text, /hi$/, "and still carries what was said");

    await removeMind(name);
  });

  it("names the install's cap, not the mind's, when the system bucket holds", async () => {
    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, IMMEDIATE);

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);
    let held: DeliveryHold | null = { reason: "spend_cap", scope: "system" };
    manager.setHoldCheck(() => held);

    await manager.routeAndDeliver(name, { channel: "test:ch", sender: "alice", content: "hi" });
    held = null;
    await manager.releaseHeld(name);
    await waitFor(async () => (await queueRows(name)).length === 0);

    const text = receivedText(srv.received[0]);
    assert.match(text, /this install's spend cap/, "a mind is not blamed for the install's cap");
    assert.doesNotMatch(text, /your spend cap/);

    await removeMind(name);
  });

  it("repeated sweeps while held neither re-POST nor advance the attempt count", async () => {
    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, IMMEDIATE);

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);
    manager.setHoldCheck(() => SPEND_HOLD);

    await manager.routeAndDeliver(name, { channel: "test:ch", sender: "alice", content: "hi" });
    const first = (await queueRows(name, "held"))[0];
    const markedAt = (JSON.parse(first.payload) as DeliveryPayload).held?.at;
    assert.ok(markedAt, "the row is stamped when it is first held");

    for (let i = 0; i < 3; i++) await manager.redrive();

    const rows = await queueRows(name, "held");
    assert.equal(srv.received.length, 0);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].attempts, 0);
    // "How long did this wait" is answered by the FIRST hold, so re-stamping would make a
    // day-long wait read as a few seconds.
    assert.equal((JSON.parse(rows[0].payload) as DeliveryPayload).held?.at, markedAt);

    await removeMind(name);
  });

  it("holds a batch too, and releases it prefaced", async () => {
    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, BATCH);

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);
    let held: DeliveryHold | null = SPEND_HOLD;
    manager.setHoldCheck(() => held);

    const one = await manager.routeAndDeliver(name, {
      channel: "test:ch",
      sender: "alice",
      content: "one",
    });
    assert.equal(one.routed && one.mode, "batch", "this test must exercise the batch path");
    await manager.routeAndDeliver(name, { channel: "test:ch", sender: "alice", content: "two" });

    await waitFor(async () => (await queueRows(name, "held")).length === 2);
    await new Promise((r) => setTimeout(r, 300)); // let the batch timers fire
    assert.equal(srv.received.length, 0, "a held batch is not POSTed");
    assert.equal((await queueRows(name, "held")).length, 2, "both messages are kept");

    held = null;
    await manager.releaseHeld(name);
    await waitFor(async () => (await queueRows(name)).length === 0, 5000);

    const text = srv.received.map(receivedText).join("\n");
    assert.match(text, /\[held —/, "the batch arrives framed as having waited");
    assert.match(text, /one/);
    assert.match(text, /two/);

    await removeMind(name);
  });

  it("a held row is not cycled through the batch buffer on every sweep", async () => {
    // The redrive check exists so a held row is skipped BEFORE it is buffered. Without it
    // the row is re-buffered, re-timed and re-flushed on every sweep for as long as the
    // hold lasts — a timer churning every 15s per held message, for up to a day.
    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, {
      rules: [{ channel: "test:*", thread: "group" }],
      threads: { group: { delivery: { mode: "batch", debounce: 5, maxWait: 5 } } },
      gateUnmatched: false,
    });

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);
    manager.setHoldCheck(() => SPEND_HOLD);

    await manager.routeAndDeliver(name, { channel: "test:ch", sender: "alice", content: "hi" });
    // The buffer from the initial enqueue flushes on its own timers; drop it so the sweep
    // is the only thing that could create one.
    (manager as unknown as { batchBuffers: Map<string, unknown> }).batchBuffers.clear();
    (manager as unknown as { inFlight: Set<number> }).inFlight.clear();

    await manager.redrive();

    const buffers = (manager as unknown as { batchBuffers: Map<string, unknown> }).batchBuffers;
    const inFlight = (manager as unknown as { inFlight: Set<number> }).inFlight;
    assert.equal(buffers.size, 0, "a held row is not re-buffered by the sweep");
    assert.equal(inFlight.size, 0, "and is not re-owned");
    assert.equal(srv.received.length, 0);
    assert.equal((await queueRows(name, "held")).length, 1, "and is still there to be released");

    await removeMind(name);
  });

  it("stamps when the message arrived, not when the hold noticed it", async () => {
    // A row that sat pending through a mind restart is first held long after it arrived.
    // Telling the mind it "arrived" at the moment we got around to holding it is the same
    // lie about waiting that the preface exists to prevent.
    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, IMMEDIATE);

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);
    manager.setHoldCheck(() => SPEND_HOLD);

    // A message that arrived two hours ago and never went out — the mind was down.
    const db = await getDb();
    const [inserted] = await db
      .insert(deliveryQueue)
      .values({
        mind: name,
        target_mind: name,
        thread: "main",
        channel: "test:ch",
        sender: "alice",
        status: "pending",
        payload: JSON.stringify({ channel: "test:ch", sender: "alice", content: "old" }),
      })
      .returning({ id: deliveryQueue.id });
    await db
      .update(deliveryQueue)
      .set({ created_at: sql`datetime('now', '-2 hours')` })
      .where(eq(deliveryQueue.id, inserted.id));

    // Now the cap trips and the sweep meets it for the first time.
    await manager.redrive();

    const held = (await queueRows(name, "held")).find((r) => r.id === inserted.id);
    assert.ok(held, "the aged row is still there, held");
    const heldAt = (JSON.parse(held.payload) as DeliveryPayload).held?.at ?? 0;
    const ageMinutes = (Date.now() - heldAt) / 60_000;
    assert.ok(
      ageMinutes > 60,
      `held.at should be the two-hour-old arrival, not now (got ${ageMinutes.toFixed(1)}m)`,
    );

    await db.delete(deliveryQueue).where(eq(deliveryQueue.mind, name));
    await removeMind(name);
  });

  it("overlapping sweeps never run concurrently, and deliver exactly once", async () => {
    // Spend releases now trigger a sweep from three places on top of the periodic timer,
    // so overlap is routine rather than theoretical. A sweep works from a snapshot and
    // yields inside its loop, so two CONCURRENT passes can both act on a row the other has
    // already delivered and deleted — that overlap is the hazard, and it is what this pins.
    //
    // Overlapping callers do queue one trailing pass behind the running sweep (#823):
    // joining a sweep that has already snapshotted its rows is not the same as being
    // swept, and `sessionDone` kicks a redrive precisely to get a row moving the instant a
    // turn ends. That pass is sequential, so it costs one extra read and no overlap.
    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, IMMEDIATE);

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);
    manager.setHoldCheck(() => SPEND_HOLD);
    await manager.routeAndDeliver(name, { channel: "test:ch", sender: "alice", content: "hi" });
    manager.setHoldCheck(() => null);
    await manager.releaseHeld(name);

    const internals = manager as unknown as { redriveInner: () => Promise<void> };
    const real = internals.redriveInner.bind(manager);
    let sweeps = 0;
    let inFlight = 0;
    let maxConcurrent = 0;
    internals.redriveInner = async () => {
      sweeps++;
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      // Hold the sweep open so the later calls are unambiguously concurrent with it.
      await new Promise((r) => setTimeout(r, 50));
      await real();
      inFlight--;
    };

    // Ten rather than three, so the bound is pinned as "one trailing pass regardless of N"
    // rather than "a small number at N=3". A regression that coalesced only PARTIALLY —
    // batching callers in pairs, say — still yields 2 here at N=3 and passes; at N=10 it
    // yields ~5 and fails. (Fully per-caller fan-out gives N and is caught at either size.)
    await Promise.all(Array.from({ length: 10 }, () => manager.redrive()));

    assert.equal(maxConcurrent, 1, "no two sweeps are ever in flight at once");
    assert.equal(sweeps, 2, "N overlapping calls collapse into the running sweep + one trailing");
    await waitFor(async () => (await queueRows(name)).length === 0);
    assert.equal(srv.received.length, 1, "and the message went out exactly once");

    await removeMind(name);
  });

  it("a held row is invisible to the sweep, so one capped mind can't starve another", async () => {
    // The sweep reads `pending` id-ordered under a batch limit. A held row that stayed
    // eligible would fill that window on every pass for as long as the hold lasts — and
    // after a daemon restart the sweep is the ONLY delivery path, so another mind's whole
    // backlog would be unreachable because this one hit its cap.
    const capped = await startMindServer();
    const other = await startMindServer();
    servers.push(capped.server, other.server);
    const cappedName = await registerMind(capped.port, IMMEDIATE);
    const otherName = await registerMind(other.port, IMMEDIATE);

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);
    manager.setHoldCheck((mind) => (mind === cappedName ? SPEND_HOLD : null));

    // The capped mind's rows land first, so they hold the low ids.
    for (let i = 0; i < 5; i++) {
      await manager.routeAndDeliver(cappedName, {
        channel: "test:ch",
        sender: "alice",
        content: `held ${i}`,
      });
    }
    assert.equal((await queueRows(cappedName, "held")).length, 5);

    // A message to a mind that is NOT capped, queued behind them.
    const db = await getDb();
    const [row] = await db
      .insert(deliveryQueue)
      .values({
        mind: otherName,
        target_mind: otherName,
        thread: "main",
        channel: "test:ch",
        sender: "bob",
        status: "pending",
        payload: JSON.stringify({ channel: "test:ch", sender: "bob", content: "unrelated" }),
      })
      .returning({ id: deliveryQueue.id });

    await manager.redrive();
    await waitFor(async () => other.received.length === 1);

    assert.equal(other.received.length, 1, "the uncapped mind still hears");
    assert.equal(capped.received.length, 0, "and the capped one still doesn't");
    assert.equal((await queueRows(otherName)).length, 0);
    void row;

    await db.delete(deliveryQueue).where(eq(deliveryQueue.mind, cappedName));
    await removeMind(cappedName);
    await removeMind(otherName);
  });

  it("bounds the release: newest per channel delivered, the rest archived with a summary", async () => {
    // A day of held traffic delivered in full is one turn per message against a budget
    // that just reset — it would spend the new period in minutes and re-trip the cap,
    // leaving the mind alternating between deaf and drowning.
    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, IMMEDIATE);

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);
    let held: DeliveryHold | null = SPEND_HOLD;
    manager.setHoldCheck(() => held);
    const notices: { detail: string }[] = [];
    manager.setFailureNotifier(async (input) => {
      notices.push({ detail: input.detail });
    });

    for (let i = 0; i < 14; i++) {
      await manager.routeAndDeliver(name, {
        channel: "test:ch",
        sender: "alice",
        content: `message ${i}`,
      });
    }
    assert.equal((await queueRows(name, "held")).length, 14);

    held = null;
    const { released, archived } = await manager.releaseHeld(name);

    assert.equal(released, 10, "only the newest ten per channel are delivered");
    assert.equal(archived, 4, "the rest are archived, not deleted");
    assert.equal((await queueRows(name, "archived")).length, 4);
    await waitFor(async () => (await queueRows(name)).length === 0);

    const text = srv.received.map(receivedText).join("\n");
    assert.match(text, /message 13/, "the newest arrived");
    assert.doesNotMatch(text, /message 0\b/, "the oldest did not");

    assert.equal(notices.length, 1, "and the mind gets one account of what waited");
    assert.match(notices[0].detail, /4/, "naming how many are not being replayed");
    assert.match(notices[0].detail, /volute chat read/, "and where to read them");

    const db = await getDb();
    await db.delete(deliveryQueue).where(eq(deliveryQueue.mind, name));
    await removeMind(name);
  });

  it("releaseHeld is a no-op while the mind is still held", async () => {
    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, IMMEDIATE);

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);
    manager.setHoldCheck(() => SPEND_HOLD);
    await manager.routeAndDeliver(name, { channel: "test:ch", sender: "alice", content: "hi" });

    const { released } = await manager.releaseHeld(name);
    assert.equal(released, 0, "releasing on a cap that hasn't lifted would hand it straight back");
    assert.equal(srv.received.length, 0);
    assert.equal((await queueRows(name, "held")).length, 1);

    const db = await getDb();
    await db.delete(deliveryQueue).where(eq(deliveryQueue.mind, name));
    await removeMind(name);
  });

  it("releaseAllHeld finds minds by their rows, including ones with no bucket", async () => {
    // The install-wide cap holds minds that have no spend bucket of their own, so a mind
    // list would miss them — the rows are the only complete answer to who is waiting.
    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, IMMEDIATE);

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);
    let held: DeliveryHold | null = { reason: "spend_cap", scope: "system" };
    manager.setHoldCheck(() => held);
    await manager.routeAndDeliver(name, { channel: "test:ch", sender: "alice", content: "hi" });
    assert.equal((await queueRows(name, "held")).length, 1);

    held = null;
    await manager.releaseAllHeld();
    await waitFor(async () => (await queueRows(name)).length === 0);
    assert.equal(srv.received.length, 1);

    await removeMind(name);
  });

  it("records history when the message arrives, stamped with when it was sent", async () => {
    // A held message must not appear in history as received while the mind hasn't seen it
    // (#420) — and the oldest of a big backlog are archived at release and never arrive at
    // all, so recording on arrival would leave history claiming what will never happen.
    // But the row that IS written says when someone spoke, not when the mind was free.
    const srv = await startMindServer();
    servers.push(srv.server);
    const name = await registerMind(srv.port, IMMEDIATE);
    const db = await getDb();

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);
    let held: DeliveryHold | null = SPEND_HOLD;
    manager.setHoldCheck(() => held);

    // What deliverMessage does at arrival for a mind it can see is held.
    await manager.routeAndDeliver(name, {
      channel: "test:ch",
      sender: "alice",
      content: "spoken while you were capped",
      inboundDeferred: true,
    });

    const rows = await queueRows(name, "held");
    assert.equal(rows.length, 1);
    let history = await db.select().from(mindHistory).where(eq(mindHistory.mind, name));
    assert.equal(history.length, 0, "nothing in history while the mind hasn't seen it");

    // Age the hold so arrival and release are unmistakably different instants — a test
    // where they are milliseconds apart cannot tell which one the row carries.
    const payload = JSON.parse(rows[0].payload) as DeliveryPayload;
    const arrivedAt = Date.now() - 2 * 60 * 60 * 1000;
    payload.held = { ...payload.held!, at: arrivedAt };
    await db
      .update(deliveryQueue)
      .set({ payload: JSON.stringify(payload) })
      .where(eq(deliveryQueue.id, rows[0].id));

    held = null;
    await manager.releaseHeld(name);
    await waitFor(async () => (await queueRows(name)).length === 0);

    history = await db.select().from(mindHistory).where(eq(mindHistory.mind, name));
    const inbound = history.filter((h) => h.type === "inbound");
    assert.equal(inbound.length, 1, "recorded once, when it actually arrived");
    assert.equal(inbound[0].content, "spoken while you were capped");
    // Stamped with the send, not the release. Parsed via parseDbTimestamp because the
    // column is zone-less UTC text — `new Date(row.created_at)` would read it as local.
    const recorded = parseDbTimestamp(inbound[0].created_at)!.getTime();
    const ageMinutes = (Date.now() - recorded) / 60_000;
    assert.ok(
      ageMinutes > 60,
      `history should carry the two-hour-old send, not the release (got ${ageMinutes.toFixed(1)}m)`,
    );

    // And the marker never reaches the mind as a field.
    assert.equal((srv.received[0] as { inboundDeferred?: boolean }).inboundDeferred, undefined);

    await db.delete(mindHistory).where(eq(mindHistory.mind, name));
    await removeMind(name);
  });

  it("does not interrupt a delivery already in flight", async () => {
    // A mind finishes what it is on. The gate is checked before the POST, never during —
    // so a hold that begins mid-turn cannot cut a thought off in the middle.
    const srv = await startMindServer(200);
    servers.push(srv.server);
    const name = await registerMind(srv.port, IMMEDIATE);

    manager = new DeliveryManager();
    manager.setRunningCheck(() => true);
    let held: DeliveryHold | null = null;
    manager.setHoldCheck(() => held);

    const inFlight = manager.routeAndDeliver(name, {
      channel: "test:ch",
      sender: "alice",
      content: "mid-thought",
    });
    // The cap trips while the POST is genuinely outstanding — gated on the mind having
    // received the request, not on a wall-clock guess about how long two DB round-trips
    // take, which is exactly the kind of timing this repo's suite flakes on under load.
    await srv.firstRequest;
    held = SPEND_HOLD;
    await inFlight;

    assert.equal(srv.received.length, 1, "the in-flight delivery completed");
    assert.equal(receivedText(srv.received[0]), "mid-thought");
    assert.equal((await queueRows(name)).length, 0, "and was acked, not held");

    await removeMind(name);
  });
});

describe("withHeldPreface", () => {
  it("leaves an unheld payload exactly as it was", () => {
    const payload: DeliveryPayload = { channel: "c", sender: "a", senderId: null, content: "hi" };
    assert.equal(withHeldPreface(payload), payload);
  });

  it("strips the marker so it never reaches the mind as a field", () => {
    const out = withHeldPreface({
      channel: "c",
      sender: "a",
      senderId: null,
      content: "hi",
      held: { at: Date.now(), scope: "mind" },
    });
    assert.equal(out.held, undefined);
  });

  it("prefaces block-array content without disturbing the blocks", () => {
    const at = Date.now();
    const out = withHeldPreface({
      channel: "c",
      sender: "a",
      senderId: null,
      content: [
        { type: "image", source: {} },
        { type: "text", text: "hi" },
      ],
      held: { at, scope: "mind" },
    });
    const blocks = out.content as { type: string; text?: string }[];
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].type, "text");
    assert.match(blocks[0].text!, /^\[held —/);
    assert.equal(blocks[1].type, "image", "the original blocks are preserved in order");
    assert.equal(blocks[2].text, "hi");
  });

  it("claims only what is true of every release path", () => {
    const line = (
      withHeldPreface({
        channel: "c",
        sender: "a",
        senderId: null,
        content: "hi",
        held: { at: Date.now(), scope: "mind" },
      }).content as string
    ).split("\n")[0];
    // A hold also ends when a host raises or clears the cap, so the preface must not
    // assert that the period reset.
    assert.doesNotMatch(line, /reset/i);
    assert.match(line, /reaching you now/);
  });
});
