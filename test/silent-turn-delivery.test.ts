import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  createUser,
  getOrCreateMindUser,
  getOrCreateSystemUser,
} from "../packages/daemon/src/lib/auth.js";
import { deliverEvent } from "../packages/daemon/src/lib/chat/system-events.js";
import {
  initMindManager,
  tryGetMindManager,
} from "../packages/daemon/src/lib/daemon/mind-manager.js";
import {
  generateMindToken,
  revokeMindToken,
} from "../packages/daemon/src/lib/daemon/mind-tokens.js";
import { initSpendBudget } from "../packages/daemon/src/lib/daemon/spend-budget.js";
import { settleHeld, summarizeTurn } from "../packages/daemon/src/lib/daemon/summarizer.js";
import { handleMindEvent } from "../packages/daemon/src/lib/daemon/turn-lifecycle.js";
import { acquireTurnSlot, releaseTurnSlot } from "../packages/daemon/src/lib/daemon/turn-slots.js";
import {
  clearMind,
  getActiveTurnId,
  holdInterrupted,
  markClosing,
  openDeliveredTurn,
  unlinkRefused,
  wasInterrupted,
} from "../packages/daemon/src/lib/daemon/turn-tracker.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  type DeliveryManager,
  initDeliveryManager,
} from "../packages/daemon/src/lib/delivery/delivery-manager.js";
import { clearConfigCache } from "../packages/daemon/src/lib/delivery/delivery-router.js";
import {
  deliverBatch,
  deliverMessage,
  recordInbound,
  recordOutbound,
  turnStamp,
} from "../packages/daemon/src/lib/delivery/message-delivery.js";
import { createConversation } from "../packages/daemon/src/lib/events/conversations.js";
import {
  type MindEvent,
  subscribe as subscribeMindEvents,
} from "../packages/daemon/src/lib/events/mind-events.js";
import { addMind, addSpirit, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import {
  conversations,
  deliveryQueue,
  messages,
  mindHistory,
  summaries,
  systemEvents,
  turns,
  users,
} from "../packages/daemon/src/lib/schema.js";
import { invalidateMindUserCache } from "../packages/daemon/src/web/middleware/auth.js";
import { resolveEffective } from "../packages/daemon/src/web/middleware/effective-principal.js";

/**
 * A `silent` mind emits no thinking, text or tool calls, so nothing it sends the daemon
 * opens a turn. The delivery it acks does (#1298). Its own file: it stands up the delivery
 * manager singleton, which would change the path every later test in a shared file takes.
 */

const MIND = "silent-turn";
const SPIRIT = "volute";
const ADMIN = "silent-turn-admin";
const PLAIN = "silent-turn-plain";

let dm: DeliveryManager;
let server: Server;
const posted: any[] = [];
/** When set, the stub mind holds its ack until this resolves — the mind runs meanwhile. */
let holdAck: Promise<void> | undefined;
/** When set, the stub mind refuses with this status, or (0) drops the connection unanswered. */
let refuse: number | undefined;
/** When set, the stub mind refuses system events (only) with 503. */
let refuseEvents = false;

before(async () => {
  try {
    initSpendBudget();
  } catch {
    // already initialized
  }
  dm = initDeliveryManager();
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      posted.push(JSON.parse(raw));
      await holdAck;
      if (refuse === 0) {
        req.socket.destroy();
        return;
      }
      if (refuseEvents && JSON.parse(raw).kind === "event") {
        res.writeHead(503);
        res.end();
        return;
      }
      if (refuse !== undefined) {
        res.writeHead(refuse);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
});

after(async () => {
  dm.dispose();
  await new Promise<void>((r) => server.close(() => r()));
});

afterEach(async () => {
  posted.length = 0;
  holdAck = undefined;
  refuse = undefined;
  refuseEvents = false;
  dm.clearMindSessions(MIND);
  releaseTurnSlot(MIND);
  await clearMind(MIND);
  const db = await getDb();
  await db.delete(mindHistory).where(eq(mindHistory.mind, MIND));
  await db.delete(turns).where(eq(turns.mind, MIND));
  await db.delete(deliveryQueue).where(eq(deliveryQueue.mind, MIND));
  await removeMind(MIND);
  clearConfigCache();
});

async function setup(): Promise<void> {
  await addMind(MIND, (server.address() as AddressInfo).port);
  const configDir = resolve(process.env.VOLUTE_HOME!, "minds", MIND, "home/.config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    resolve(configDir, "routes.json"),
    JSON.stringify({ default: "main", gateUnmatched: false }),
  );
  clearConfigCache(MIND);
}

async function waitFor<T>(read: () => T | Promise<T>, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("a delivery opens the turn it runs in (#1298)", () => {
  it("a silent mind's delivered message gets a turn with it as the exact trigger", async () => {
    await setup();
    const db = await getDb();
    // Untagged history on the same channel from long before: not this turn's.
    const [old] = await db
      .insert(mindHistory)
      .values({ mind: MIND, type: "inbound", channel: "@tester", content: "months ago" })
      .returning({ id: mindHistory.id });

    assert.equal(
      await deliverMessage(MIND, {
        channel: "@tester",
        sender: "tester",
        senderId: null,
        content: "hello",
      }),
      true,
    );
    const turnId = await waitFor(() => getActiveTurnId(MIND, "main"));
    assert.ok(turnId, "the acked delivery opens the turn");
    assert.equal(posted.length, 1);
    assert.equal(JSON.stringify(posted[0]).includes("historyId"), false, "never on the wire");

    const inbound = await db
      .select()
      .from(mindHistory)
      .where(and(eq(mindHistory.mind, MIND), eq(mindHistory.content, "hello")))
      .get();
    // The link runs just after the turn opens; wait for it.
    await waitFor(
      async () =>
        (await db.select().from(mindHistory).where(eq(mindHistory.id, inbound!.id)).get())!.turn_id,
    );
    const turnOf = async (id: number) =>
      (await db.select().from(mindHistory).where(eq(mindHistory.id, id)).get())!.turn_id;
    assert.equal(await turnOf(inbound!.id), turnId);
    assert.equal(await turnOf(old.id), null, "older history is not swept in");

    // All a silent mind reports beyond its send: its `done`, naming the delivery it ran.
    const outboundId = await recordOutbound(MIND, "@tester", "hi", turnStamp(MIND, "main"));
    assert.equal(await turnOf(outboundId!), turnId, "the send is stamped with the turn");
    const delivery = posted[0].deliveryId as string;
    await handleMindEvent(MIND, {
      type: "done",
      session: "main",
      messageId: delivery,
      covers: [delivery],
    });
    const turn = await db.select().from(turns).where(eq(turns.id, turnId!)).get();
    assert.equal(turn!.status, "complete");
    assert.equal(turn!.trigger_event_id, inbound!.id);

    // The next message opens the next turn before the first turn's usage is handled.
    await deliverMessage(MIND, {
      channel: "@tester",
      sender: "tester",
      senderId: null,
      content: "more",
    });
    const next = await waitFor(() => getActiveTurnId(MIND, "main"));
    assert.ok(next && next !== turnId);

    // Then the first turn's usage lands, long after — a retried POST. No time window applies,
    // and the turn running now is not where it goes.
    const realNow = Date.now;
    Date.now = () => realNow() + 5 * 60_000;
    try {
      const late = await handleMindEvent(MIND, {
        type: "usage",
        session: "main",
        messageId: delivery,
        metadata: { input_tokens: 1, output_tokens: 1 },
      });
      assert.equal(late.turnId, turnId, "the usage is its own turn's");
    } finally {
      Date.now = realNow;
    }
    // The running turn's own usage still lands on it.
    const own = await handleMindEvent(MIND, {
      type: "usage",
      session: "main",
      messageId: posted[1].deliveryId,
      metadata: { input_tokens: 1, output_tokens: 1 },
    });
    assert.equal(own.turnId, next);
  });

  it("a silent turn that sends nothing keeps its row and a summary of what reached it", async () => {
    await setup();
    const db = await getDb();
    await deliverMessage(MIND, {
      channel: "@tester",
      sender: "tester",
      senderId: null,
      content: "hi",
    });
    const turnId = await waitFor(() => getActiveTurnId(MIND, "main"));
    assert.ok(turnId);

    // Upgraded templates land usage before done.
    await handleMindEvent(MIND, {
      type: "usage",
      session: "main",
      metadata: { input_tokens: 10, output_tokens: 7 },
    });
    await handleMindEvent(MIND, { type: "done", session: "main" });

    const summary = await waitFor(async () =>
      db.select().from(summaries).where(eq(summaries.period_key, turnId!)).get(),
    );
    assert.ok(summary, "the turn is summarized");
    assert.match(summary!.content, /no visible output/);
    const turn = await db.select().from(turns).where(eq(turns.id, turnId!)).get();
    assert.equal(turn?.status, "complete", "and not deleted as interrupted");
    await db.delete(summaries).where(eq(summaries.period_key, turnId!));
  });

  it("an ack handled after its turn's done opens nothing, and its row stays on that turn", async () => {
    await setup();
    const db = await getDb();
    let ack!: () => void;
    holdAck = new Promise((r) => (ack = r));
    const delivering = deliverMessage(MIND, {
      channel: "@tester",
      sender: "tester",
      senderId: null,
      content: "quick one",
    });
    await waitFor(() => posted.length === 1);
    const turnId = getActiveTurnId(MIND, "main");
    assert.ok(turnId, "the turn is open before the mind sees the message");

    // The turn is quick: it replies, and its done is handled before the delivery's ack.
    await recordOutbound(MIND, "@tester", "done already", turnStamp(MIND, "main"));
    const delivery = posted[0].deliveryId as string;
    await handleMindEvent(MIND, {
      type: "done",
      session: "main",
      messageId: delivery,
      covers: [delivery],
    });
    ack();
    await delivering;
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(getActiveTurnId(MIND, "main"), undefined, "no turn is left open");
    assert.equal((await db.select().from(turns).where(eq(turns.mind, MIND)).all()).length, 1);
    const inbound = await db
      .select()
      .from(mindHistory)
      .where(and(eq(mindHistory.mind, MIND), eq(mindHistory.content, "quick one")))
      .get();
    assert.equal(inbound!.turn_id, turnId);
  });

  it("back-to-back silent turns: one the daemon saw fold in gets its own row at its done", async () => {
    await setup();
    const db = await getDb();
    const rowOf = async (content: string) =>
      (await db
        .select()
        .from(mindHistory)
        .where(and(eq(mindHistory.mind, MIND), eq(mindHistory.content, content)))
        .get())!;

    await deliverMessage(MIND, {
      channel: "@tester",
      sender: "tester",
      senderId: null,
      content: "one",
    });
    const t1 = await waitFor(() => getActiveTurnId(MIND, "main"));
    // The second arrives while the first runs: the daemon folds it in, the mind runs it next.
    await deliverMessage(MIND, {
      channel: "@tester",
      sender: "tester",
      senderId: null,
      content: "two",
    });
    await waitFor(() => posted.length === 2);
    await waitFor(async () => (await rowOf("two")).turn_id);
    assert.equal((await rowOf("two")).turn_id, t1, "linked to the running turn meanwhile");
    const [d1, d2] = posted.map((p) => p.deliveryId as string);

    await recordOutbound(MIND, "@tester", "re: one", turnStamp(MIND, "main"));
    await handleMindEvent(MIND, { type: "done", session: "main", messageId: d1, covers: [d1] });
    // The second turn reports only its usage and its done.
    await handleMindEvent(MIND, {
      type: "usage",
      session: "main",
      messageId: d2,
      metadata: { input_tokens: 5, output_tokens: 3 },
    });
    const { turnId: t2 } = await handleMindEvent(MIND, {
      type: "done",
      session: "main",
      messageId: d2,
      covers: [d2],
    });

    assert.ok(t2 && t2 !== t1, "the second turn has its own row");
    const turn2 = await db.select().from(turns).where(eq(turns.id, t2!)).get();
    assert.equal(turn2!.status, "complete");
    const two = await rowOf("two");
    assert.equal(two.turn_id, t2, "its message moved to it");
    assert.equal(turn2!.trigger_event_id, two.id);
    const usage = await db
      .select()
      .from(mindHistory)
      .where(and(eq(mindHistory.mind, MIND), eq(mindHistory.type, "usage")))
      .get();
    assert.equal(usage!.turn_id, t2, "and the usage it reported before its done");
    assert.equal(getActiveTurnId(MIND, "main"), undefined, "nothing is left open");
    await waitFor(() => db.select().from(summaries).where(eq(summaries.period_key, t2!)).get());
    await db.delete(summaries).where(eq(summaries.period_key, t2!));
    await db.delete(summaries).where(eq(summaries.period_key, t1!));
  });

  // #1320, lyrb's shape: a silent mind on an `interrupt: true` thread. The interrupter's run
  // has no turn while it goes — its turn is recorded at its `done` — so what it sends then
  // carries none. Each send is stamped with the delivery being run, and that delivery's
  // `done` takes exactly its own: its summary says it replied.
  it("a run recorded at its done takes exactly what it sent, and isn't summarized as quiet", async () => {
    await setup();
    const configDir = resolve(process.env.VOLUTE_HOME!, "minds", MIND, "home/.config");
    writeFileSync(
      resolve(configDir, "routes.json"),
      JSON.stringify({
        default: "main",
        gateUnmatched: false,
        threads: { main: { interrupt: true } },
      }),
    );
    clearConfigCache(MIND);
    const db = await getDb();
    const VARIANT = `${MIND}@v`;
    const rowOf = async (type: string, content: string, mind = MIND) =>
      (await db
        .select()
        .from(mindHistory)
        .where(
          and(
            eq(mindHistory.mind, mind),
            eq(mindHistory.type, type),
            eq(mindHistory.content, content),
          ),
        )
        .get())!;
    if (!tryGetMindManager()) initMindManager();
    const mindUser = await getOrCreateMindUser(MIND);
    const human = await createUser(`${MIND}-human`, "pass");
    const conv = await createConversation({ participantIds: [mindUser.id, human.id] });
    const token = generateMindToken(MIND);
    const app = (await import("../packages/daemon/src/web/app.js")).default as unknown as {
      request: typeof fetch;
    };
    /** A send from the thread, through the chat API — what `volute chat send` does. */
    const send = async (text: string) => {
      const res = await app.request("http://localhost/api/v1/chat", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "http://localhost",
          "Content-Type": "application/json",
          "X-Volute-Thread": "main",
        },
        body: JSON.stringify({ conversationId: conv.id, message: text }),
      } as RequestInit);
      assert.equal(res.status, 200, await res.clone().text());
      const row = await rowOf("outbound", text);
      return Number(row.message_id);
    };
    /** A variant's send from the same thread name, as the chat API records it. */
    const variantSend = async (text: string) => {
      const stamp = turnStamp(MIND, "main", VARIANT);
      await recordOutbound(VARIANT, "@tester", text, stamp);
    };
    const deliver = (content: string) =>
      deliverMessage(MIND, { channel: "@tester", sender: "tester", senderId: null, content });

    // An earlier run's send no turn ever took: stamped with a delivery no `done` here covers.
    await recordOutbound(MIND, "@tester", "EARLIER", { thread: "main", delivery: "d-earlier" });
    await deliver("one");
    const t1 = await waitFor(() => getActiveTurnId(MIND, "main"));
    await deliver("two");
    await deliver("three");
    await waitFor(() => posted.length === 3);
    assert.equal(posted[1].interrupt, true, "it was sent to interrupt");
    const [d1, d2, d3] = posted.map((p) => p.deliveryId as string);

    // The interrupted run ends; the interrupter runs with no turn to stamp.
    await handleMindEvent(MIND, { type: "done", session: "main", messageId: d1, covers: [d1] });
    assert.equal(getActiveTurnId(MIND, "main"), undefined);
    await handleMindEvent(MIND, {
      type: "context",
      session: "main",
      content: "pre-prompt",
      metadata: { source: "dynamic:pre-prompt" },
    });
    // A variant on the same thread reports meanwhile: its context is not this run's.
    await handleMindEvent(
      MIND,
      { type: "context", session: "main", content: "variant context" },
      VARIANT,
    );
    const hotel = await send("HOTEL");
    assert.equal((await rowOf("outbound", "HOTEL")).turn_id, null, "sent with no turn");
    await variantSend("VARIANT");
    await handleMindEvent(MIND, {
      type: "usage",
      session: "main",
      messageId: d2,
      metadata: { input_tokens: 5, output_tokens: 3 },
    });
    const { turnId: t2 } = await handleMindEvent(MIND, {
      type: "done",
      session: "main",
      messageId: d2,
      covers: [d2],
    });
    // The run queued behind it sends, and ends.
    await send("INDIA");
    const { turnId: t3 } = await handleMindEvent(MIND, {
      type: "done",
      session: "main",
      messageId: d3,
      covers: [d3],
    });

    assert.ok(t2 && t2 !== t1, "the interrupter's turn has its own row");
    assert.ok(t3 && t3 !== t2, "and so does the run after it");
    assert.equal((await rowOf("inbound", "two")).turn_id, t2);
    assert.equal((await rowOf("outbound", "HOTEL")).turn_id, t2, "its reply is in it");
    const sent = await db.select().from(messages).where(eq(messages.id, hotel)).get();
    assert.equal(sent!.turn_id, t2, "and so is the message it sent");
    assert.equal((await rowOf("context", "pre-prompt")).turn_id, t2, "and its context");
    assert.equal((await rowOf("outbound", "INDIA")).turn_id, t3, "the next run's send is its own");
    assert.equal((await rowOf("outbound", "EARLIER")).turn_id, null, "nothing from before it");
    assert.equal(
      (await rowOf("outbound", "VARIANT", VARIANT)).turn_id,
      null,
      "nor a variant's send",
    );
    assert.equal((await rowOf("context", "variant context")).turn_id, null, "nor its context");
    const summary = await waitFor(() =>
      db.select().from(summaries).where(eq(summaries.period_key, t2!)).get(),
    );
    assert.doesNotMatch(summary!.content, /no visible output/);
    await waitFor(() => db.select().from(summaries).where(eq(summaries.period_key, t3!)).get());
    for (const t of [t1!, t2!, t3!]) await db.delete(summaries).where(eq(summaries.period_key, t));
    revokeMindToken(MIND);
    await db.delete(messages).where(eq(messages.conversation_id, conv.id));
    await db.delete(conversations).where(eq(conversations.id, conv.id));
    await db.delete(mindHistory).where(eq(mindHistory.mind, VARIANT));
    await db.delete(users).where(inArray(users.id, [mindUser.id, human.id]));
    invalidateMindUserCache(MIND);
  });

  // #1319: one run can consume several deliveries; its `done` covers them all, and its turn
  // takes what was sent under any of them.
  it("a run that consumed two deliveries takes the sends stamped with either", async () => {
    await setup();
    const db = await getDb();
    const outbound = async (content: string) =>
      (await db
        .select()
        .from(mindHistory)
        .where(and(eq(mindHistory.mind, MIND), eq(mindHistory.content, content)))
        .get())!;
    (dm as any).addOutstanding(MIND, "main", "dA", MIND);
    (dm as any).addOutstanding(MIND, "main", "dB", MIND);
    await recordOutbound(MIND, "@tester", "first", turnStamp(MIND, "main"));
    assert.equal(JSON.parse((await outbound("first")).metadata!).delivery, "dA");
    await recordOutbound(MIND, "@tester", "second", { thread: "main", delivery: "dB" });
    const { turnId } = await handleMindEvent(MIND, {
      type: "done",
      session: "main",
      messageId: "dA",
      covers: ["dA", "dB"],
    });
    assert.ok(turnId);
    assert.equal((await outbound("first")).turn_id, turnId);
    assert.equal((await outbound("second")).turn_id, turnId);
    await waitFor(() => db.select().from(summaries).where(eq(summaries.period_key, turnId!)).get());
    await db.delete(summaries).where(eq(summaries.period_key, turnId!));
  });

  // A run that consumed a delivery its `done` didn't name (an old template, #1319) leaves it
  // outstanding, so the next run's send is stamped with it. The next `done` retires every
  // delivery up to the one it names, the leftover with it, and its turn takes the send —
  // never the finished run's.
  it("a send stamped with a leftover delivery goes to the run that sent it", async () => {
    await setup();
    const db = await getDb();
    const outbound = async (content: string) =>
      (await db
        .select()
        .from(mindHistory)
        .where(and(eq(mindHistory.mind, MIND), eq(mindHistory.content, content)))
        .get())!;
    (dm as any).addOutstanding(MIND, "main", "d1", MIND);
    (dm as any).addOutstanding(MIND, "main", "d2", MIND);
    await recordOutbound(MIND, "@tester", "from one", turnStamp(MIND, "main"));
    const { turnId: t1 } = await handleMindEvent(MIND, {
      type: "done",
      session: "main",
      messageId: "d1",
      covers: ["d1"],
    });
    (dm as any).addOutstanding(MIND, "main", "d3", MIND);
    await recordOutbound(MIND, "@tester", "from three", turnStamp(MIND, "main"));
    assert.equal(JSON.parse((await outbound("from three")).metadata!).delivery, "d2");
    const { turnId: t3 } = await handleMindEvent(MIND, {
      type: "done",
      session: "main",
      messageId: "d3",
      covers: ["d3"],
    });
    assert.ok(t1 && t3 && t1 !== t3);
    assert.equal((await outbound("from one")).turn_id, t1);
    assert.equal((await outbound("from three")).turn_id, t3, "the run that sent it");
    for (const t of [t1!, t3!]) {
      await waitFor(() => db.select().from(summaries).where(eq(summaries.period_key, t)).get());
      await db.delete(summaries).where(eq(summaries.period_key, t));
    }
  });

  it("a quiet turn whose usage lands after its done is held for it, then kept", async () => {
    await setup();
    const db = await getDb();
    await deliverMessage(MIND, {
      channel: "@tester",
      sender: "tester",
      senderId: null,
      content: "hi",
    });
    const turnId = await waitFor(() => getActiveTurnId(MIND, "main"));
    const delivery = posted[0].deliveryId as string;
    await handleMindEvent(MIND, {
      type: "done",
      session: "main",
      messageId: delivery,
      covers: [delivery],
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(
      await db.select().from(turns).where(eq(turns.id, turnId!)).get(),
      "not deleted while its usage is still to come",
    );
    await handleMindEvent(MIND, {
      type: "usage",
      session: "main",
      messageId: delivery,
      metadata: { input_tokens: 5, output_tokens: 3 },
    });
    const summary = await waitFor(() =>
      db.select().from(summaries).where(eq(summaries.period_key, turnId!)).get(),
    );
    assert.match(summary!.content, /no visible output/);
    await db.delete(summaries).where(eq(summaries.period_key, turnId!));
  });

  it("a turn whose usage never comes is held while the next turn opens, then hands it its message", async () => {
    await setup();
    const db = await getDb();
    await deliverMessage(MIND, {
      channel: "@tester",
      sender: "tester",
      senderId: null,
      content: "hi",
    });
    const turnId = await waitFor(() => getActiveTurnId(MIND, "main"));
    const delivery = posted[0].deliveryId as string;
    await handleMindEvent(MIND, {
      type: "done",
      session: "main",
      messageId: delivery,
      covers: [delivery],
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(await db.select().from(turns).where(eq(turns.id, turnId!)).get(), "held for now");
    // The next message on the thread opens its turn.
    await deliverMessage(MIND, {
      channel: "@tester",
      sender: "tester",
      senderId: null,
      content: "again",
    });
    const next = await waitFor(() => {
      const t = getActiveTurnId(MIND, "main");
      return t && t !== turnId ? t : undefined;
    });
    // A turn opening next proves nothing about the held one's usage: it is still held.
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(await db.select().from(turns).where(eq(turns.id, turnId!)).get(), "still held");
    // Its hold runs out with no usage: it was interrupted.
    settleHeld(turnId!);
    const gone = await waitFor(
      async () => !(await db.select().from(turns).where(eq(turns.id, turnId!)).get()),
    );
    assert.ok(gone, "taken back as interrupted");
    const hi = await waitFor(async () => {
      const r = await db
        .select()
        .from(mindHistory)
        .where(and(eq(mindHistory.mind, MIND), eq(mindHistory.content, "hi")))
        .get();
      return r?.turn_id === next ? r : undefined;
    });
    assert.ok(hi, "the turn that answers it has its message");
    const again = await db
      .select()
      .from(mindHistory)
      .where(and(eq(mindHistory.mind, MIND), eq(mindHistory.content, "again")))
      .get();
    const turn = await db.select().from(turns).where(eq(turns.id, next!)).get();
    assert.equal(turn!.trigger_event_id, again!.id, "its own message stays its trigger");
  });

  it("deferred messages that go out ahead of an event begin its turn, and are its trigger", async () => {
    await setup();
    const db = await getDb();
    assert.ok(
      await dm.deferMessage(MIND, "main", {
        channel: "@tester",
        sender: "tester",
        senderId: null,
        content: "kept for later",
        inboundDeferred: true,
      }),
    );
    const seen: MindEvent[] = [];
    const unsubscribe = subscribeMindEvents(MIND, (e) => seen.push(e));
    const { delivered } = await deliverEvent(MIND, { type: "schedule", body: "time to check" });
    assert.ok(delivered);
    const turnId = getActiveTurnId(MIND, "main");
    assert.ok(turnId);
    const rows = await waitFor(async () => {
      const r = await db.select().from(mindHistory).where(eq(mindHistory.mind, MIND)).all();
      return r.length === 2 && r.every((x) => x.turn_id) ? r : undefined;
    });
    assert.ok(rows, "both rows are linked to the turn");
    const human = rows!.find((r) => r.type === "inbound")!;
    const event = rows!.find((r) => r.type === "event")!;
    assert.equal(human.turn_id, turnId);
    assert.equal(event.turn_id, turnId);
    const turn = await db.select().from(turns).where(eq(turns.id, turnId!)).get();
    assert.equal(turn!.trigger_event_id, human.id, "the human's message, not the event");
    // Both rows, written after the turn opened, reach a live timeline as part of it.
    for (const type of ["inbound", "event"]) {
      assert.equal(
        seen.find((e) => e.type === type)?.turnId,
        turnId,
        `${type} published in its turn`,
      );
    }
    unsubscribe();
    await db.delete(systemEvents).where(eq(systemEvents.mind, MIND));
  });

  it("a message folding into the spirit's admin turn drops it to basic before the mind sees it", async () => {
    const port = (server.address() as AddressInfo).port;
    await addSpirit(SPIRIT, port);
    const spirit = await getOrCreateSystemUser();
    const admin = await createUser(ADMIN, "pass");
    const plain = await createUser(PLAIN, "pass");
    const thread = `@${ADMIN}`;
    try {
      await deliverMessage(SPIRIT, {
        channel: thread,
        session: thread,
        sender: admin.username,
        senderId: admin.id,
        content: "do the admin thing",
      });
      await waitFor(() => getActiveTurnId(SPIRIT, thread));
      assert.equal((await resolveEffective({ user: spirit, mindSession: thread })).role, "admin");

      // A second sender's message folds in. While the mind is being handed it — before
      // any ack — the spirit no longer acts with the admin's authority.
      let ack!: () => void;
      holdAck = new Promise((r) => (ack = r));
      const folding = deliverMessage(SPIRIT, {
        channel: thread,
        session: thread,
        sender: plain.username,
        senderId: plain.id,
        content: "while you're at it…",
      });
      await waitFor(() => posted.length === 2);
      assert.equal((await resolveEffective({ user: spirit, mindSession: thread })).role, "basic");
      ack();
      await folding;
    } finally {
      dm.clearMindSessions(SPIRIT);
      releaseTurnSlot(SPIRIT);
      await clearMind(SPIRIT);
      const db = await getDb();
      await db.delete(mindHistory).where(eq(mindHistory.mind, SPIRIT));
      await db.delete(turns).where(eq(turns.mind, SPIRIT));
      await db.delete(deliveryQueue).where(eq(deliveryQueue.mind, SPIRIT));
      await db.delete(users).where(inArray(users.username, [SPIRIT, ADMIN, PLAIN]));
      await removeMind(SPIRIT);
    }
  });

  it("a delivery the mind refuses takes its turn back with it", async () => {
    await setup();
    const seen: MindEvent[] = [];
    const unsubscribe = subscribeMindEvents(MIND, (e) => seen.push(e));
    refuse = 503;
    await deliverMessage(MIND, {
      channel: "@tester",
      sender: "tester",
      senderId: null,
      content: "no",
    });
    await waitFor(() => posted.length === 1);
    const db = await getDb();
    const gone = await waitFor(
      async () => (await db.select().from(turns).where(eq(turns.mind, MIND)).all()).length === 0,
    );
    assert.ok(gone, "no turn ran, so none is left");
    assert.equal(getActiveTurnId(MIND, "main"), undefined);
    // A live timeline that showed it opening is told it is gone.
    const opened = seen.find((e) => e.type === "turn_created")?.turnId;
    assert.ok(opened);
    assert.ok(
      await waitFor(() => seen.some((e) => e.type === "turn_discarded" && e.turnId === opened)),
    );
    unsubscribe();
  });

  it("a delivery whose POST goes unanswered keeps its turn — the mind may be running it", async () => {
    await setup();
    refuse = 0;
    await deliverMessage(MIND, {
      channel: "@tester",
      sender: "tester",
      senderId: null,
      content: "?",
    });
    await waitFor(() => posted.length === 1);
    await new Promise((r) => setTimeout(r, 200));
    const db = await getDb();
    const rows = await db.select().from(turns).where(eq(turns.mind, MIND)).all();
    assert.equal(rows.length, 1);
    const inbound = await db
      .select()
      .from(mindHistory)
      .where(and(eq(mindHistory.mind, MIND), eq(mindHistory.content, "?")))
      .get();
    assert.equal(inbound!.turn_id, rows[0].id);
  });

  it("the next delivery folds into a turn whose POST went unanswered — the mind may be running it", async () => {
    await setup();
    const db = await getDb();
    refuse = 0;
    await deliverMessage(MIND, {
      channel: "@tester",
      sender: "tester",
      senderId: null,
      content: "lost?",
    });
    await waitFor(() => posted.length === 1);
    const first = await waitFor(() => getActiveTurnId(MIND, "main"));
    await new Promise((r) => setTimeout(r, 100));
    refuse = undefined;
    // A silent mind says nothing while it runs; the next message takes the free slot.
    await deliverMessage(MIND, {
      channel: "@tester",
      sender: "tester",
      senderId: null,
      content: "next",
    });
    await waitFor(() => posted.length === 2);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(getActiveTurnId(MIND, "main"), first, "joined, not deleted and replaced");
    const rows = await db
      .select()
      .from(mindHistory)
      .where(and(eq(mindHistory.mind, MIND), eq(mindHistory.type, "inbound")))
      .all();
    assert.deepEqual(
      rows.map((r) => r.turn_id),
      [first, first],
    );
    const turn = await db.select().from(turns).where(eq(turns.id, first!)).get();
    assert.equal(turn!.trigger_event_id, rows.find((r) => r.content === "lost?")!.id);
  });

  it("a delivery that joins its process's running turn moves on with it if not covered", async () => {
    await setup();
    const db = await getDb();
    // The mind is already working on the thread, on its own.
    const { turnId: running } = await handleMindEvent(MIND, {
      type: "text",
      session: "main",
      messageId: "m-own",
      content: "x",
    });
    const [row] = await db
      .insert(mindHistory)
      .values({ mind: MIND, type: "inbound", channel: "@tester", content: "joined" })
      .returning({ id: mindHistory.id });
    (dm as any).addOutstanding(MIND, "main", "d-join", MIND, undefined, undefined, [row.id]);
    const entered = await (dm as any).enterTurn(MIND, "main", MIND, "d-join", true, [row.id]);
    assert.equal(entered.turnId, running);
    // The running turn ends without covering it: the mind runs it next, as its own turn.
    await handleMindEvent(MIND, { type: "done", session: "main", messageId: "m-own", covers: [] });
    const { turnId: next } = await handleMindEvent(MIND, {
      type: "text",
      session: "main",
      messageId: "d-join",
      content: "y",
    });
    assert.ok(next && next !== running);
    const moved = await db.select().from(mindHistory).where(eq(mindHistory.id, row.id)).get();
    assert.equal(moved!.turn_id, next);
  });

  it("a refused delivery doesn't carry off what an interrupted turn left; the next one does", async () => {
    await setup();
    const db = await getDb();
    const [left] = await db
      .insert(mindHistory)
      .values({ mind: MIND, type: "inbound", channel: "@tester", content: "cut off" })
      .returning({ id: mindHistory.id });
    await holdInterrupted(MIND, "main", [left.id]);
    refuse = 503;
    await deliverMessage(MIND, {
      channel: "@tester",
      sender: "tester",
      senderId: null,
      content: "no",
    });
    await waitFor(() => posted.length === 1);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      (await db.select().from(mindHistory).where(eq(mindHistory.id, left.id)).get())!.turn_id,
      null,
    );
    refuse = undefined;
    await deliverMessage(MIND, {
      channel: "@tester",
      sender: "tester",
      senderId: null,
      content: "yes",
    });
    const turnId = await waitFor(() => getActiveTurnId(MIND, "main"));
    const adopted = await waitFor(
      async () =>
        (await db.select().from(mindHistory).where(eq(mindHistory.id, left.id)).get())!.turn_id,
    );
    assert.equal(adopted, turnId);
    const yes = await db
      .select()
      .from(mindHistory)
      .where(and(eq(mindHistory.mind, MIND), eq(mindHistory.content, "yes")))
      .get();
    const turn = await db.select().from(turns).where(eq(turns.id, turnId!)).get();
    assert.equal(turn!.trigger_event_id, yes!.id, "its own message is the trigger");
  });

  it("a delivery POSTed to interrupt marks the turn it folds into as interrupted", async () => {
    await setup();
    const { turnId: running } = await handleMindEvent(MIND, {
      type: "text",
      session: "main",
      content: "x",
    });
    (dm as any).addOutstanding(MIND, "main", "d-int", MIND);
    await (dm as any).enterTurn(MIND, "main", MIND, "d-int", false, [], true);
    assert.equal(wasInterrupted(running!), true);
  });

  it("a refused delivery that folded into a running turn stays in it — its sender may have been read", async () => {
    await setup();
    const db = await getDb();
    const { turnId: running } = await handleMindEvent(MIND, {
      type: "text",
      session: "main",
      content: "working",
    });
    refuse = 503;
    await deliverMessage(MIND, {
      channel: "@tester",
      sender: "tester",
      senderId: null,
      content: "nope",
    });
    await waitFor(() => posted.length === 1);
    await new Promise((r) => setTimeout(r, 100));
    const row = await db
      .select()
      .from(mindHistory)
      .where(and(eq(mindHistory.mind, MIND), eq(mindHistory.content, "nope")))
      .get();
    assert.equal(row!.turn_id, running);
  });

  it("a refused interrupting delivery leaves the turn it would have interrupted unmarked", async () => {
    await setup();
    const configDir = resolve(process.env.VOLUTE_HOME!, "minds", MIND, "home/.config");
    writeFileSync(
      resolve(configDir, "routes.json"),
      JSON.stringify({
        default: "main",
        gateUnmatched: false,
        threads: { main: { interrupt: true } },
      }),
    );
    clearConfigCache(MIND);
    const { turnId: running } = await handleMindEvent(MIND, {
      type: "text",
      session: "main",
      content: "x",
    });
    refuse = 503;
    await deliverMessage(MIND, {
      channel: "@tester",
      sender: "tester",
      senderId: null,
      content: "stop",
    });
    await waitFor(() => posted.length === 1);
    assert.equal(posted[0].interrupt, true, "it was sent to interrupt");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(wasInterrupted(running!), false, "refused, it interrupted nothing");
  });

  for (const silent of [true, false]) {
    it(`a wake batch folded into a running turn moves to its own when run so (${silent ? "silent" : "chatty"})`, async () => {
      await setup();
      const db = await getDb();
      const { turnId: running } = await handleMindEvent(MIND, {
        type: "text",
        session: "main",
        messageId: "m-own",
        content: "working",
      });
      const historyId = await recordInbound(MIND, "@tester", "tester", null, "overnight");
      assert.equal(
        await deliverBatch(MIND, [
          { channel: "@tester", sender: "tester", senderId: null, content: "overnight", historyId },
        ]),
        true,
      );
      const delivery = posted[0].deliveryId as string;
      assert.ok(delivery, "the batch is POSTed with its delivery id");
      await handleMindEvent(MIND, {
        type: "done",
        session: "main",
        messageId: "m-own",
        covers: [],
      });
      // The mind runs the batch as a turn of its own.
      const { turnId } = silent
        ? await handleMindEvent(MIND, {
            type: "done",
            session: "main",
            messageId: delivery,
            covers: [delivery],
          })
        : await handleMindEvent(MIND, {
            type: "text",
            session: "main",
            messageId: delivery,
            content: "good morning",
          });
      assert.ok(turnId && turnId !== running, "its own turn");
      const row = await db.select().from(mindHistory).where(eq(mindHistory.id, historyId!)).get();
      assert.equal(row!.turn_id, turnId);
      const turn = await db.select().from(turns).where(eq(turns.id, turnId!)).get();
      assert.equal(turn!.trigger_event_id, historyId);
    });
  }

  it("a turn is summarized once, however many passes reach it at the same moment", async () => {
    await setup();
    const db = await getDb();
    const seen: MindEvent[] = [];
    const unsubscribe = subscribeMindEvents(MIND, (e) => seen.push(e));
    const historyId = await recordInbound(MIND, "@tester", "tester", null, "hm");
    const opened = await (dm as any).enterTurn(MIND, "main", MIND, "d-x", true, [historyId], false);
    await db.insert(mindHistory).values([
      {
        mind: MIND,
        type: "usage",
        thread: "main",
        metadata: '{"output_tokens":0}',
        turn_id: opened.turnId,
      },
      { mind: MIND, type: "done", thread: "main", turn_id: opened.turnId },
    ]);
    await Promise.all([
      summarizeTurn(MIND, "main", undefined, 0, opened.turnId),
      summarizeTurn(MIND, "main", undefined, 0, opened.turnId),
    ]);
    assert.equal(seen.filter((e) => e.type === "turn_discarded").length, 1);
    unsubscribe();
  });

  it("a quiet turn whose usage lands just after the next turn opens is kept", async () => {
    await setup();
    const db = await getDb();
    await deliverMessage(MIND, {
      channel: "@tester",
      sender: "tester",
      senderId: null,
      content: "a",
    });
    const first = await waitFor(() => getActiveTurnId(MIND, "main"));
    const delivery = posted[0].deliveryId as string;
    await handleMindEvent(MIND, {
      type: "done",
      session: "main",
      messageId: delivery,
      covers: [delivery],
    });
    await deliverMessage(MIND, {
      channel: "@tester",
      sender: "tester",
      senderId: null,
      content: "b",
    });
    await waitFor(() => posted.length === 2);
    // The first turn's usage, POSTed with its done, is handled only now.
    await handleMindEvent(MIND, {
      type: "usage",
      session: "main",
      messageId: delivery,
      metadata: { output_tokens: 4 },
    });
    const summary = await waitFor(() =>
      db.select().from(summaries).where(eq(summaries.period_key, first!)).get(),
    );
    assert.match(summary!.content, /no visible output/, "kept as quiet");
    await db.delete(summaries).where(eq(summaries.period_key, first!));
  });

  it("a refused delivery's turn lets go of what folded into it, which runs in its own", async () => {
    await setup();
    const db = await getDb();
    const [a] = await db
      .insert(mindHistory)
      .values({ mind: MIND, type: "inbound", channel: "@tester", content: "A" })
      .returning({ id: mindHistory.id });
    const [b] = await db
      .insert(mindHistory)
      .values({ mind: MIND, type: "inbound", channel: "@tester", content: "B" })
      .returning({ id: mindHistory.id });
    (dm as any).addOutstanding(MIND, "main", "dA", MIND, undefined, undefined, [a.id]);
    const opened = await (dm as any).enterTurn(MIND, "main", MIND, "dA", true, [a.id], false);
    (dm as any).addOutstanding(MIND, "main", "dB", MIND, undefined, undefined, [b.id]);
    await (dm as any).enterTurn(MIND, "main", MIND, "dB", false, [b.id], false);
    // The mind refuses A; B was taken.
    (dm as any).dropOutstanding(MIND, "main", "dA");
    (dm as any).unfold(MIND, "main", opened.turnId);
    await unlinkRefused(MIND, "main", opened.turnId, [a.id], true);
    assert.equal(await db.select().from(turns).where(eq(turns.id, opened.turnId)).get(), undefined);
    // The mind runs B as a turn of its own.
    const { turnId } = await handleMindEvent(MIND, {
      type: "text",
      session: "main",
      messageId: "dB",
      content: "on B",
    });
    const row = await db.select().from(mindHistory).where(eq(mindHistory.id, b.id)).get();
    assert.equal(row!.turn_id, turnId);
  });

  it("an interrupting delivery doesn't mark a turn whose done has already come", async () => {
    await setup();
    const { turnId: running } = await handleMindEvent(MIND, {
      type: "text",
      session: "main",
      messageId: "m1",
      content: "x",
    });
    markClosing(MIND, "main", running!, ["m1"]);
    (dm as any).addOutstanding(MIND, "main", "d-late", MIND);
    await (dm as any).enterTurn(MIND, "main", MIND, "d-late", false, [], true);
    assert.equal(wasInterrupted(running!), false);
  });

  it("deferred messages refused ahead of an event leave the event's turn for their own", async () => {
    await setup();
    const db = await getDb();
    const historyId = await recordInbound(MIND, "@tester", "tester", null, "kept");
    assert.ok(
      await dm.deferMessage(MIND, "main", {
        channel: "@tester",
        sender: "tester",
        senderId: null,
        content: "kept",
        historyId,
      }),
    );
    const eventTurn = (await openDeliveredTurn(MIND, "main", MIND))!.turnId;
    refuse = 503;
    assert.equal(await dm.flushDeferred(MIND, "main", eventTurn), false);
    await new Promise((r) => setTimeout(r, 100));
    const row = await db.select().from(mindHistory).where(eq(mindHistory.id, historyId!)).get();
    assert.equal(row!.turn_id, null, "free for the turn it runs in when sent again");
    const turn = await db.select().from(turns).where(eq(turns.id, eventTurn)).get();
    assert.notEqual(turn?.trigger_event_id, historyId);
  });

  it("a message delivered while a schedule event takes the spirit's slot is in its turn: no system authority", async () => {
    const port = (server.address() as AddressInfo).port;
    await addSpirit(SPIRIT, port);
    const spirit = await getOrCreateSystemUser();
    await createUser(ADMIN, "pass"); // the first user is the admin; the next is not
    const plain = await createUser(PLAIN, "pass");
    let ack!: () => void;
    holdAck = new Promise((r) => (ack = r));
    try {
      // The schedule event takes the slot; its POST hangs, so the turn is open, unacked.
      const firing = deliverEvent(SPIRIT, { type: "schedule", body: "tick", thread: "main" });
      const eventTurn = await waitFor(() => getActiveTurnId(SPIRIT, "main"));
      assert.ok(eventTurn, "the event's turn is open as soon as it holds the slot");
      // A non-admin's message lands on the thread in that moment and folds in.
      const folding = deliverMessage(SPIRIT, {
        channel: `@${PLAIN}`,
        session: "main",
        sender: plain.username,
        senderId: plain.id,
        content: "do something for me",
      });
      await waitFor(() => posted.length === 2);
      const rows = await (await getDb())
        .select()
        .from(mindHistory)
        .where(and(eq(mindHistory.mind, SPIRIT), eq(mindHistory.type, "inbound")))
        .all();
      assert.deepEqual(
        rows.map((r) => r.turn_id),
        [eventTurn],
        "the message is in the event's turn",
      );
      const role = (await resolveEffective({ user: spirit, mindSession: "main" })).role;
      assert.notEqual(role, "system", "the spirit doesn't act on it as its own schedule");
      assert.notEqual(role, "admin");
      ack();
      await firing;
      await folding;
    } finally {
      ack?.();
      dm.clearMindSessions(SPIRIT);
      releaseTurnSlot(SPIRIT);
      await clearMind(SPIRIT);
      const db = await getDb();
      await db.delete(mindHistory).where(eq(mindHistory.mind, SPIRIT));
      await db.delete(turns).where(eq(turns.mind, SPIRIT));
      await db.delete(deliveryQueue).where(eq(deliveryQueue.mind, SPIRIT));
      await db.delete(systemEvents).where(eq(systemEvents.mind, SPIRIT));
      await db.delete(users).where(inArray(users.username, [SPIRIT, ADMIN, PLAIN]));
      await removeMind(SPIRIT);
    }
  });

  it("a message acked in the gap before a schedule event's turn opened is taken in by it", async () => {
    const port = (server.address() as AddressInfo).port;
    await addSpirit(SPIRIT, port);
    const spirit = await getOrCreateSystemUser();
    await createUser(ADMIN, "pass");
    const plain = await createUser(PLAIN, "pass");
    try {
      // The event holds the slot but its turn isn't open yet; a non-admin's message is
      // delivered and acked in that gap, joining no turn.
      acquireTurnSlot(SPIRIT, "main");
      await deliverMessage(SPIRIT, {
        channel: `@${PLAIN}`,
        session: "main",
        sender: plain.username,
        senderId: plain.id,
        content: "in the gap",
      });
      await waitFor(() => posted.length === 1);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(getActiveTurnId(SPIRIT, "main"), undefined);
      // The event's turn then opens.
      releaseTurnSlot(SPIRIT, "main");
      await deliverEvent(SPIRIT, { type: "schedule", body: "tick", thread: "main" });
      const eventTurn = getActiveTurnId(SPIRIT, "main");
      assert.ok(eventTurn);
      const row = await waitFor(async () => {
        const r = await (await getDb())
          .select()
          .from(mindHistory)
          .where(and(eq(mindHistory.mind, SPIRIT), eq(mindHistory.content, "in the gap")))
          .get();
        return r?.turn_id === eventTurn ? r : undefined;
      });
      assert.ok(row, "taken into the event's turn");
      const role = (await resolveEffective({ user: spirit, mindSession: "main" })).role;
      assert.notEqual(role, "system");
      assert.notEqual(role, "admin");
    } finally {
      dm.clearMindSessions(SPIRIT);
      releaseTurnSlot(SPIRIT);
      await clearMind(SPIRIT);
      const db = await getDb();
      await db.delete(mindHistory).where(eq(mindHistory.mind, SPIRIT));
      await db.delete(turns).where(eq(turns.mind, SPIRIT));
      await db.delete(deliveryQueue).where(eq(deliveryQueue.mind, SPIRIT));
      await db.delete(systemEvents).where(eq(systemEvents.mind, SPIRIT));
      await db.delete(users).where(inArray(users.username, [SPIRIT, ADMIN, PLAIN]));
      await removeMind(SPIRIT);
    }
  });

  it("a turn just opened takes in a delivery that found no turn to join", async () => {
    await setup();
    const db = await getDb();
    const [d] = await db
      .insert(mindHistory)
      .values({ mind: MIND, type: "inbound", channel: "@tester", content: "in the gap" })
      .returning({ id: mindHistory.id });
    // Delivered as the slot was taken, before the turn opened: it joined nothing.
    (dm as any).addOutstanding(MIND, "main", "d-gap", MIND, undefined, undefined, [d.id]);
    const [e] = await db
      .insert(mindHistory)
      .values({ mind: MIND, type: "inbound", channel: "@tester", content: "slot holder" })
      .returning({ id: mindHistory.id });
    (dm as any).addOutstanding(MIND, "main", "d-slot", MIND, undefined, undefined, [e.id]);
    const entered = await (dm as any).enterTurn(MIND, "main", MIND, "d-slot", true, [e.id], false);
    await new Promise((r) => setTimeout(r, 50));
    const row = await db.select().from(mindHistory).where(eq(mindHistory.id, d.id)).get();
    assert.equal(row!.turn_id, entered.turnId);
    const turn = await db.select().from(turns).where(eq(turns.id, entered.turnId)).get();
    assert.equal(turn!.trigger_event_id, e.id, "not the trigger");
  });

  it("a refused event's turn lets go of a message that folded into it", async () => {
    await setup();
    const db = await getDb();
    refuseEvents = true;
    let ack!: () => void;
    holdAck = new Promise((r) => (ack = r));
    const firing = deliverEvent(MIND, { type: "schedule", body: "tick", thread: "main" });
    const eventTurn = await waitFor(() => getActiveTurnId(MIND, "main"));
    const folding = deliverMessage(MIND, {
      channel: "@tester",
      sender: "tester",
      senderId: null,
      content: "folded",
    });
    await waitFor(() => posted.length === 2);
    ack();
    await firing;
    await folding;
    await new Promise((r) => setTimeout(r, 100));
    holdAck = undefined;
    refuseEvents = false;
    const folded = async () =>
      (await db
        .select()
        .from(mindHistory)
        .where(and(eq(mindHistory.mind, MIND), eq(mindHistory.content, "folded")))
        .get())!;
    assert.notEqual((await folded()).turn_id, eventTurn, "not left on the refused event's turn");
    // The next message's turn takes it in: the mind has it.
    await deliverMessage(MIND, {
      channel: "@tester",
      sender: "tester",
      senderId: null,
      content: "next",
    });
    const next = await waitFor(() => {
      const t = getActiveTurnId(MIND, "main");
      return t && t !== eventTurn ? t : undefined;
    });
    assert.ok(next);
    assert.ok(await waitFor(async () => ((await folded()).turn_id === next ? true : undefined)));
  });
});
