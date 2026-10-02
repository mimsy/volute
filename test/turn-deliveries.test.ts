import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { drainEvents, recordNotice } from "../packages/daemon/src/lib/chat/system-events.js";
import { getTypingMap } from "../packages/daemon/src/lib/chat/typing.js";
import { initSpendBudget } from "../packages/daemon/src/lib/daemon/spend-budget.js";
import { settleHeld } from "../packages/daemon/src/lib/daemon/summarizer.js";
import { drainNotices, handleMindEvent } from "../packages/daemon/src/lib/daemon/turn-lifecycle.js";
import { hasTurnSlot } from "../packages/daemon/src/lib/daemon/turn-slots.js";
import {
  clearMind,
  closedTurnFor,
  getActiveTurnId,
  holdInterrupted,
  markErrored,
  markInterrupted,
  openDeliveredTurn,
  recordDrained,
  takeDrained,
  takeErrored,
} from "../packages/daemon/src/lib/daemon/turn-tracker.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  type DeliveryManager,
  initDeliveryManager,
} from "../packages/daemon/src/lib/delivery/delivery-manager.js";
import { mindHistory, summaries, systemEvents, turns } from "../packages/daemon/src/lib/schema.js";

/**
 * A `done` names the turn it ends (`messageId`) and the deliveries it finished (`covers`),
 * because only the mind knows whether a delivery folded into a running turn, ran as a turn
 * of its own, or failed while another turn ran on (#1207). Its own file: the delivery
 * manager singleton it stands up would otherwise change the path every later test in a
 * shared file takes.
 */

let dm: DeliveryManager;
before(() => {
  dm = initDeliveryManager();
  try {
    initSpendBudget(); // usage events accrue against it
  } catch {
    // already initialized
  }
});
after(() => dm.dispose());

const minds: string[] = [];
afterEach(async () => {
  const db = await getDb();
  for (const mind of minds.splice(0)) {
    dm.clearMindSessions(mind);
    await clearMind(mind);
    await db.delete(mindHistory).where(eq(mindHistory.mind, mind));
    await db.delete(turns).where(eq(turns.mind, mind));
    await db.delete(systemEvents).where(eq(systemEvents.mind, mind));
  }
});

function mindNamed(name: string): string {
  minds.push(name);
  return name;
}

/** Stand in for DeliveryManager's bookkeeping on a POST to the mind. */
function delivered(mind: string, session: string, id: string, process = mind): void {
  (dm as any).addOutstanding(mind, session, id, process);
}

async function turnStatus(turnId: string): Promise<string | undefined> {
  const db = await getDb();
  return (await db.select().from(turns).where(eq(turns.id, turnId)).get())?.status;
}

async function notice(mind: string, detail: string): Promise<number> {
  const id = await recordNotice({
    mind,
    thread: "s1",
    kind: "turn_error",
    reason: "network",
    detail,
  });
  return id!;
}

async function bodies(mind: string): Promise<string[]> {
  return (await drainEvents(mind, "s1")).map((n) => n.body);
}

/** The notice clear runs fire-and-forget on `done`; wait for it to settle. */
async function settled(mind: string, gone: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && (await bodies(mind)).includes(gone)) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("a done names the deliveries it covers", () => {
  it("a turn two deliveries folded into completes on its one done", async () => {
    const mind = mindNamed("td-folded");
    delivered(mind, "s1", "d1");
    const { turnId } = await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      messageId: "d1",
      content: "a",
    });
    delivered(mind, "s1", "d2"); // arrives mid-run and folds in
    await handleMindEvent(mind, {
      type: "done",
      session: "s1",
      messageId: "d1",
      covers: ["d1", "d2"],
    });

    assert.equal(getActiveTurnId(mind, "s1", mind), undefined, "the turn should be closed");
    assert.equal(await turnStatus(turnId!), "complete");
    assert.equal(dm.isSessionBusy(mind, "s1"), false);
    assert.equal(hasTurnSlot(mind, "s1"), false, "the slot is free");

    // The session isn't left wedged: the next turn is its own and completes too.
    delivered(mind, "s1", "d3");
    const next = await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      messageId: "d3",
      content: "b",
    });
    assert.ok(next.turnId && next.turnId !== turnId);
    await handleMindEvent(mind, { type: "done", session: "s1", messageId: "d3", covers: ["d3"] });
    assert.equal(await turnStatus(next.turnId!), "complete");
  });

  it("a folded turn marks the notices it drained delivered", async () => {
    const mind = mindNamed("td-folded-notices");
    await notice(mind, "A");
    delivered(mind, "s1", "d1");
    await drainNotices(mind, "s1", mind, "d1");
    await handleMindEvent(mind, { type: "text", session: "s1", messageId: "d1", content: "a" });
    delivered(mind, "s1", "d2");
    await handleMindEvent(mind, {
      type: "done",
      session: "s1",
      messageId: "d1",
      covers: ["d1", "d2"],
    });
    await settled(mind, "A");
    assert.deepEqual(await bodies(mind), []);
  });

  it("the next turn's drain stays with the next turn, whatever order it lands in", async () => {
    const mind = mindNamed("td-drain-race");
    await notice(mind, "A");
    delivered(mind, "s1", "d1");
    await drainNotices(mind, "s1", mind, "d1");
    await handleMindEvent(mind, { type: "text", session: "s1", messageId: "d1", content: "N" });

    // d2 was queued behind N. Its turn's drain of B lands before N's done is even handled.
    delivered(mind, "s1", "d2");
    await notice(mind, "B");
    await drainNotices(mind, "s1", mind, "d2");
    await handleMindEvent(mind, { type: "done", session: "s1", messageId: "d1", covers: ["d1"] });

    await settled(mind, "A");
    assert.deepEqual(await bodies(mind), ["B"], "N clears only what N drained");
    assert.equal(dm.isSessionBusy(mind, "s1"), true, "d2 is still to run");
    assert.equal(hasTurnSlot(mind, "s1"), true, "and holds the slot for it");

    // N+1 fails: B was drained into a turn that errored, so it must survive.
    await handleMindEvent(mind, { type: "text", session: "s1", messageId: "d2", content: "N+1" });
    await handleMindEvent(mind, { type: "error", session: "s1", messageId: "d2", content: "boom" });
    await handleMindEvent(mind, { type: "done", session: "s1", messageId: "d2", covers: ["d2"] });
    assert.ok((await bodies(mind)).includes("B"), "B survives N+1's error");
    assert.equal(hasTurnSlot(mind, "s1"), false, "nothing left to run: the slot is free");
  });

  it("a failed delivery's done retires it without ending the turn running beside it", async () => {
    // pi: d1 is streaming; d2 was queued as a followUp and its prompt rejected.
    const mind = mindNamed("td-pi-failure");
    delivered(mind, "s1", "d1");
    const { turnId } = await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      messageId: "d1",
      content: "streaming",
    });
    delivered(mind, "s1", "d2");
    await handleMindEvent(mind, { type: "error", session: "s1", messageId: "d2", content: "x" });
    await handleMindEvent(mind, {
      type: "done",
      session: "s1",
      messageId: "d2",
      covers: ["d2"],
      endsTurn: false,
    });

    assert.equal(getActiveTurnId(mind, "s1", mind), turnId, "the running turn is untouched");
    assert.equal(dm.isSessionBusy(mind, "s1"), true, "d1 is still running");
    assert.equal(hasTurnSlot(mind, "s1"), true);

    // d2's error was d2's: the running turn still completes clean and clears its drain.
    await notice(mind, "A");
    await drainNotices(mind, "s1", mind, "d1");
    await handleMindEvent(mind, { type: "done", session: "s1", messageId: "d1", covers: ["d1"] });
    assert.equal(await turnStatus(turnId!), "complete");
    assert.equal(dm.isSessionBusy(mind, "s1"), false);
    await settled(mind, "A");
    assert.ok(!(await bodies(mind)).includes("A"), "d1's turn was clean");
  });

  it("a failed delivery's done keeps the slot for the turn beside it, even with nothing outstanding", async () => {
    // The running turn came from a system event, which the daemon POSTs outside the
    // delivery bookkeeping: once d2 is retired nothing is outstanding, yet a turn still runs.
    const mind = mindNamed("td-pi-failure-event");
    const { turnId } = await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      messageId: "e1",
      content: "answering an event",
    });
    delivered(mind, "s1", "d2");
    await handleMindEvent(mind, {
      type: "done",
      session: "s1",
      messageId: "d2",
      covers: ["d2"],
      endsTurn: false,
    });
    assert.equal(getActiveTurnId(mind, "s1", mind), turnId);
    assert.equal(dm.isSessionBusy(mind, "s1"), false);
    assert.equal(hasTurnSlot(mind, "s1"), true, "the slot stays with the running turn");
  });

  it("a done that doesn't close the running turn isn't recorded as that turn's end", async () => {
    // The wedged-turn sweep reads a turn's `done` rows as its having ended.
    const mind = mindNamed("td-not-closing");
    delivered(mind, "s1", "d1");
    const { turnId } = await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      messageId: "d1",
      content: "a",
    });
    delivered(mind, "s1", "d2");
    const { insertedId } = await handleMindEvent(mind, {
      type: "done",
      session: "s1",
      messageId: "d2",
      covers: ["d2"],
      endsTurn: false,
    });
    const db = await getDb();
    const row = await db.select().from(mindHistory).where(eq(mindHistory.id, insertedId!)).get();
    assert.equal(row!.turn_id, null);
    assert.equal(getActiveTurnId(mind, "s1", mind), turnId);
  });

  it("an interrupted delivery the done forgot is finished by the turn that took over", async () => {
    // pi steer: d2 interrupts d1's run and takes it over; a template that failed to name d1
    // must not leave it holding the session busy and the slot taken.
    const mind = mindNamed("td-steer");
    delivered(mind, "s1", "d1");
    const { turnId } = await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      messageId: "d1",
      content: "a",
    });
    delivered(mind, "s1", "d2");
    await handleMindEvent(mind, { type: "done", session: "s1", messageId: "d2", covers: ["d2"] });
    assert.equal(await turnStatus(turnId!), "complete");
    assert.equal(dm.isSessionBusy(mind, "s1"), false);
    assert.equal(hasTurnSlot(mind, "s1"), false);
  });

  it("a done that names nothing still ends the turn", async () => {
    // A turn whose message went unnamed (claude input re-queued after a rotation, pi's retry
    // continuation) still ends when its `done` comes.
    const mind = mindNamed("td-unnamed");
    const { turnId } = await handleMindEvent(mind, { type: "text", session: "s1", content: "a" });
    await handleMindEvent(mind, { type: "done", session: "s1", covers: [] });
    assert.equal(await turnStatus(turnId!), "complete");
  });

  it("a variant's done neither closes its parent's turn nor retires its deliveries", async () => {
    const mind = mindNamed("td-variant");
    const variant = `${mind}@v`;
    delivered(mind, "s1", "d1");
    delivered(mind, "s1", "v1", variant);
    const { turnId } = await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      messageId: "d1",
      content: "parent",
    });
    await notice(mind, "A");
    await drainNotices(mind, "s1", mind, "d1");
    await handleMindEvent(mind, { type: "error", session: "s1", messageId: "d1", content: "e" });

    // A bare done from an un-upgraded variant: it covers only the variant's own.
    await handleMindEvent(mind, { type: "done", session: "s1", messageId: "v1" }, variant);
    assert.equal(getActiveTurnId(mind, "s1", mind), turnId, "the parent's turn runs on");
    assert.equal(dm.isSessionBusy(mind, "s1"), true, "the parent's delivery is outstanding");

    // The parent's turn still owns its drain and its error.
    await handleMindEvent(mind, { type: "done", session: "s1", messageId: "d1", covers: ["d1"] });
    assert.equal(await turnStatus(turnId!), "complete");
    assert.ok((await bodies(mind)).includes("A"), "the parent's turn errored, so A survives");
  });

  it("a bare done covers everything outstanding for its process and ends the turn", async () => {
    // A template that predates `covers`. Host decision: no fallback to a count.
    const mind = mindNamed("td-bare");
    delivered(mind, "s1", "d1");
    delivered(mind, "s1", "d2");
    const { turnId } = await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      messageId: "d1",
      content: "a",
    });
    await notice(mind, "A");
    await drainNotices(mind, "s1", mind);
    await handleMindEvent(mind, { type: "done", session: "s1", messageId: "d1" });
    assert.equal(await turnStatus(turnId!), "complete");
    assert.equal(dm.isSessionBusy(mind, "s1"), false);
    assert.equal(hasTurnSlot(mind, "s1"), false);
    await settled(mind, "A");
    assert.deepEqual(await bodies(mind), []);
  });

  it("a mind's stop forgets the drained notices and error flags of turns that never ended", async () => {
    const mind = mindNamed("td-stop");
    recordDrained(mind, "s1", mind, [7], "d1");
    markErrored(mind, "s1", mind, "d1");
    await clearMind(mind);
    assert.deepEqual(takeDrained(mind, "s1", mind), []);
    assert.equal(takeErrored(mind, "s1", mind), false);
  });

  it("a failed delivery's done frees the slot once the turn it failed beside has ended", async () => {
    // pi awaits the rejected prompt's error before its done, so the running turn's done can
    // land first — and, with the failed delivery still outstanding, cannot free the slot.
    const mind = mindNamed("td-pi-failure-late");
    delivered(mind, "s1", "d1");
    await handleMindEvent(mind, { type: "text", session: "s1", messageId: "d1", content: "a" });
    delivered(mind, "s1", "d2");
    await handleMindEvent(mind, { type: "done", session: "s1", messageId: "d1", covers: ["d1"] });
    assert.equal(hasTurnSlot(mind, "s1"), true, "d2 is still outstanding");
    await handleMindEvent(mind, {
      type: "done",
      session: "s1",
      messageId: "d2",
      covers: ["d2"],
      endsTurn: false,
    });
    assert.equal(dm.isSessionBusy(mind, "s1"), false);
    assert.equal(hasTurnSlot(mind, "s1"), false, "no turn runs on, so the slot goes back");
  });

  it("a done that ends no turn leaves the running turn's typing indicator be", async () => {
    const mind = mindNamed("td-typing");
    delivered(mind, "s1", "d1");
    await handleMindEvent(mind, { type: "text", session: "s1", messageId: "d1", content: "a" });
    const typing = getTypingMap();
    typing.set("@alice", mind, { persistent: true });
    delivered(mind, "s1", "d2");
    await handleMindEvent(mind, {
      type: "done",
      session: "s1",
      messageId: "d2",
      covers: ["d2"],
      endsTurn: false,
    });
    assert.ok(typing.get("@alice").includes(mind), "still typing on d1's turn");
    await handleMindEvent(mind, { type: "done", session: "s1", messageId: "d1", covers: ["d1"] });
    assert.ok(!typing.get("@alice").includes(mind));
  });

  it("a variant's turn beside its parent's delivers the notices it drained", async () => {
    const mind = mindNamed("td-variant-notices");
    const variant = `${mind}@v`;
    delivered(mind, "s1", "d1");
    await handleMindEvent(mind, { type: "text", session: "s1", messageId: "d1", content: "p" });
    delivered(mind, "s1", "v1", variant);
    await notice(mind, "A");
    await drainNotices(mind, "s1", variant, "v1");
    await handleMindEvent(
      mind,
      { type: "done", session: "s1", messageId: "v1", covers: ["v1"] },
      variant,
    );
    await settled(mind, "A");
    assert.ok(!(await bodies(mind)).includes("A"), "the variant's clean turn delivered A");
  });

  it("a done completes only the turn it saw, not one another process opened meanwhile", async () => {
    const mind = mindNamed("td-late-turn");
    const variant = `${mind}@v`;
    delivered(mind, "s1", "v1", variant);
    // The variant's done arrives with no turn active; before it completes, the parent's
    // first event opens a turn on the same thread.
    const vDone = handleMindEvent(
      mind,
      { type: "done", session: "s1", messageId: "v1", covers: ["v1"] },
      variant,
    );
    const parent = handleMindEvent(mind, { type: "text", session: "s1", content: "p" });
    await vDone;
    const { turnId } = await parent;
    assert.equal(getActiveTurnId(mind, "s1", mind), turnId, "the parent's turn runs on");
    assert.equal(await turnStatus(turnId!), "active");
  });

  it("an id the daemon never delivered keys nothing of its own", async () => {
    // Minds are untrusted: an error or drain naming an id that isn't an outstanding
    // delivery is read as naming no turn, so it can't grow per-delivery state — and it
    // still counts against the session's next turn.
    const mind = mindNamed("td-bogus-ids");
    delivered(mind, "s1", "d1");
    await handleMindEvent(mind, { type: "text", session: "s1", messageId: "d1", content: "a" });
    await notice(mind, "A");
    await drainNotices(mind, "s1", mind, "made-up-1");
    await handleMindEvent(mind, {
      type: "error",
      session: "s1",
      messageId: "made-up-2",
      content: "x",
    });
    await handleMindEvent(mind, { type: "done", session: "s1", messageId: "d1", covers: ["d1"] });
    assert.deepEqual(takeDrained(mind, "s1", mind), [], "the drain went to d1's turn");
    assert.equal(takeErrored(mind, "s1", mind), false, "and so did the error");
    assert.ok((await bodies(mind)).includes("A"), "which errored, so A survives");
  });

  it("a done that saw no turn completes none — not even its own process's next one", async () => {
    // A claude stream that errors before any event sends error + done; the next queued
    // turn's first event can open a turn while that done is still being recorded.
    const mind = mindNamed("td-late-own-turn");
    delivered(mind, "s1", "d1");
    delivered(mind, "s1", "d2");
    const d1Done = handleMindEvent(mind, {
      type: "done",
      session: "s1",
      messageId: "d1",
      covers: ["d1"],
    });
    const next = handleMindEvent(mind, {
      type: "text",
      session: "s1",
      messageId: "d2",
      content: "b",
    });
    await d1Done;
    const { turnId } = await next;
    assert.equal(await turnStatus(turnId!), "active", "d2's turn is not split off at d1's done");
  });

  it("a parent's message that waited behind its variant's turn gets the parent's own turn (#1298)", async () => {
    const mind = mindNamed("td-variant-waited");
    const variant = `${mind}@v`;
    const db = await getDb();
    // The variant's turn runs on the thread; the parent's message, delivered with no slot,
    // is linked to nothing — the running turn isn't the parent's.
    delivered(mind, "s1", "v1", variant);
    const { turnId: vTurn } = await handleMindEvent(
      mind,
      { type: "text", session: "s1", messageId: "v1", content: "v" },
      variant,
    );
    const [row] = await db
      .insert(mindHistory)
      .values({ mind, type: "inbound", channel: "@alice", thread: "s1", content: "for the parent" })
      .returning({ id: mindHistory.id });
    (dm as any).addOutstanding(mind, "s1", "p1", mind, undefined, undefined, [row.id]);
    await handleMindEvent(
      mind,
      { type: "done", session: "s1", messageId: "v1", covers: ["v1"] },
      variant,
    );
    // The parent, silent, reports only its done.
    const { turnId } = await handleMindEvent(mind, {
      type: "done",
      session: "s1",
      messageId: "p1",
      covers: ["p1"],
    });
    assert.ok(turnId && turnId !== vTurn);
    const linked = await db.select().from(mindHistory).where(eq(mindHistory.id, row.id)).get();
    assert.equal(linked!.turn_id, turnId);
    assert.equal(
      (await db.select().from(turns).where(eq(turns.id, turnId!)).get())!.trigger_event_id,
      row.id,
    );
  });

  it("a done handled while the last turn is still closing gets its own turn (#1298)", async () => {
    const mind = mindNamed("td-closing-done");
    const db = await getDb();
    delivered(mind, "s1", "d1");
    const { turnId: a } = await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      messageId: "d1",
      content: "a",
    });
    const [row] = await db
      .insert(mindHistory)
      .values({ mind, type: "inbound", channel: "@alice", thread: "s1", content: "second" })
      .returning({ id: mindHistory.id });
    (dm as any).addOutstanding(mind, "s1", "d2", mind, undefined, undefined, [row.id]);
    // The silent second turn's done lands while the first's completion is being recorded.
    const first = handleMindEvent(mind, {
      type: "done",
      session: "s1",
      messageId: "d1",
      covers: ["d1"],
    });
    const second = handleMindEvent(mind, {
      type: "done",
      session: "s1",
      messageId: "d2",
      covers: ["d2"],
    });
    await first;
    const { turnId: b } = await second;
    assert.ok(b && b !== a, "the second done is its own turn's, not the closing one's");
    const linked = await db.select().from(mindHistory).where(eq(mindHistory.id, row.id)).get();
    assert.equal(linked!.turn_id, b);
  });

  it("a later sweep doesn't take the trigger from the delivery a turn runs (#1298)", async () => {
    const mind = mindNamed("td-adopt-trigger");
    const db = await getDb();
    delivered(mind, "s1", "d1");
    await handleMindEvent(mind, { type: "text", session: "s1", messageId: "d1", content: "a" });
    // An event folds in, left unlinked; then a message folds in and is not covered.
    const [event] = await db
      .insert(mindHistory)
      .values({ mind, type: "event", channel: "@alice", content: "schedule" })
      .returning({ id: mindHistory.id });
    const [message] = await db
      .insert(mindHistory)
      .values({ mind, type: "inbound", channel: "@alice", content: "from alice" })
      .returning({ id: mindHistory.id });
    (dm as any).addOutstanding(mind, "s1", "d2", mind, undefined, undefined, [message.id]);
    await handleMindEvent(mind, { type: "done", session: "s1", messageId: "d1", covers: ["d1"] });
    // The mind runs the message as its own turn.
    const { turnId } = await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      channel: "@alice",
      messageId: "d2",
      content: "b",
    });
    const turn = await db.select().from(turns).where(eq(turns.id, turnId!)).get();
    assert.equal(turn!.trigger_event_id, message.id, "not the event the sweep found");
    void event;
  });

  it("a turn opening while a done is recorded doesn't take what that done covered (#1298)", async () => {
    const mind = mindNamed("td-retiring");
    const db = await getDb();
    delivered(mind, "s1", "d1");
    const { turnId: a } = await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      messageId: "d1",
      content: "a",
    });
    // d2 folded into a, and a's done covers it.
    const [row] = await db
      .insert(mindHistory)
      .values({
        mind,
        type: "inbound",
        channel: "@alice",
        thread: "s1",
        content: "folded",
        turn_id: a,
      })
      .returning({ id: mindHistory.id });
    (dm as any).addOutstanding(mind, "s1", "d2", mind, undefined, undefined, [row.id]);
    (dm as any).sessionStates.get(mind).get("s1").outstanding.get("d2").foldedInto = a;
    // The mind's next turn starts while a's done is still being recorded.
    const closing = handleMindEvent(mind, {
      type: "done",
      session: "s1",
      messageId: "d1",
      covers: ["d1", "d2"],
    });
    const next = handleMindEvent(mind, { type: "text", session: "s1", content: "next" });
    await closing;
    const { turnId: b } = await next;
    assert.ok(b && b !== a);
    const kept = await db.select().from(mindHistory).where(eq(mindHistory.id, row.id)).get();
    assert.equal(kept!.turn_id, a, "it stays with the turn that ran it");
  });

  it("a done without covers keeps only what it names for its turn's late reports", async () => {
    const mind = mindNamed("td-legacy-closed");
    delivered(mind, "s1", "d1");
    const { turnId } = await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      messageId: "d1",
      content: "a",
    });
    delivered(mind, "s1", "d2"); // the mind will run this as its own next turn
    await handleMindEvent(mind, { type: "done", session: "s1", messageId: "d1" });
    assert.equal(closedTurnFor("s1", mind, "d1"), turnId);
    assert.equal(closedTurnFor("s1", mind, "d2"), undefined, "d2's usage is not this turn's");
  });

  it("folded deliveries a turn adopted move on again when that turn doesn't cover them", async () => {
    const mind = mindNamed("td-readopt");
    const db = await getDb();
    delivered(mind, "s1", "d1");
    const { turnId: a } = await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      messageId: "d1",
      content: "a",
    });
    const folded = async (id: string, content: string) => {
      const [row] = await db
        .insert(mindHistory)
        .values({ mind, type: "inbound", channel: "@alice", thread: "s1", content, turn_id: a })
        .returning({ id: mindHistory.id });
      (dm as any).addOutstanding(mind, "s1", id, mind, undefined, undefined, [row.id]);
      (dm as any).sessionStates.get(mind).get("s1").outstanding.get(id).foldedInto = a;
      return row.id;
    };
    await folded("d2", "two");
    const three = await folded("d3", "three");
    await handleMindEvent(mind, { type: "done", session: "s1", messageId: "d1", covers: ["d1"] });
    // d2 runs next and its turn takes both; its done covers only d2 (one turn per follow-up).
    await handleMindEvent(mind, { type: "text", session: "s1", messageId: "d2", content: "b" });
    await handleMindEvent(mind, { type: "done", session: "s1", messageId: "d2", covers: ["d2"] });
    // d3 runs as its own turn too.
    const { turnId: c } = await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      messageId: "d3",
      content: "c",
    });
    const row = await db.select().from(mindHistory).where(eq(mindHistory.id, three)).get();
    assert.equal(row!.turn_id, c);
    assert.equal(
      (await db.select().from(turns).where(eq(turns.id, c!)).get())!.trigger_event_id,
      three,
    );
  });

  it("a usage named by a done's own id, sent before it, joins the turn that done records", async () => {
    const mind = mindNamed("td-early-usage");
    const db = await getDb();
    delivered(mind, "s1", "d2");
    const { insertedId: usageId } = await handleMindEvent(mind, {
      type: "usage",
      session: "s1",
      messageId: "m-x",
      metadata: { output_tokens: 3 },
    });
    const { turnId } = await handleMindEvent(mind, {
      type: "done",
      session: "s1",
      messageId: "m-x",
      covers: ["d2"],
    });
    assert.ok(turnId);
    const usage = await db.select().from(mindHistory).where(eq(mindHistory.id, usageId!)).get();
    assert.equal(usage!.turn_id, turnId);
  });

  it("a usage handled alongside the done that records its turn lands on that turn", async () => {
    const mind = mindNamed("td-usage-race");
    const db = await getDb();
    delivered(mind, "s1", "d2");
    // A silent mind POSTs both at once; the usage is handled first but awaits its pricing.
    const usage = handleMindEvent(mind, {
      type: "usage",
      session: "s1",
      messageId: "d2",
      metadata: { output_tokens: 5 },
    });
    const done = handleMindEvent(mind, {
      type: "done",
      session: "s1",
      messageId: "d2",
      covers: ["d2"],
    });
    const [{ insertedId }, { turnId }] = await Promise.all([usage, done]);
    assert.ok(turnId);
    const row = await db.select().from(mindHistory).where(eq(mindHistory.id, insertedId!)).get();
    assert.equal(row!.turn_id, turnId);
  });

  it("a held turn finds a usage written without it when its hold runs out, and is kept", async () => {
    const mind = mindNamed("td-usage-backstop");
    const db = await getDb();
    delivered(mind, "s1", "d2");
    const { turnId } = await handleMindEvent(mind, {
      type: "done",
      session: "s1",
      messageId: "d2",
      covers: ["d2"],
    });
    assert.ok(turnId);
    // Its usage was written with no turn, having raced the done.
    await db.insert(mindHistory).values({
      mind,
      type: "usage",
      thread: "s1",
      message_id: "d2",
      metadata: JSON.stringify({ output_tokens: 6 }),
    });
    await new Promise((r) => setTimeout(r, 50));
    settleHeld(turnId!);
    const deadline = Date.now() + 3000;
    let summary: unknown;
    while (!summary && Date.now() < deadline) {
      summary = await db.select().from(summaries).where(eq(summaries.period_key, turnId!)).get();
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(summary, "kept as quiet, not taken back as interrupted");
    await db.delete(summaries).where(eq(summaries.period_key, turnId!));
  });

  for (const pi of [true, false]) {
    it(`an interrupt the turn's own done covers didn't cut it off (${pi ? "pi: kept" : "claude: taken back"})`, async () => {
      const mind = mindNamed(pi ? "td-interrupt-pi" : "td-interrupt-claude");
      const db = await getDb();
      delivered(mind, "s1", "d1");
      const opened = await openDeliveredTurn(mind, "s1", mind);
      delivered(mind, "s1", "d2"); // POSTed to interrupt the running turn
      markInterrupted(opened!.turnId, "d2");
      await handleMindEvent(mind, {
        type: "usage",
        session: "s1",
        messageId: "d1",
        metadata: { output_tokens: 7 },
      });
      // pi folds the interrupting message into the same run: one done covers both. claude
      // runs it as a turn of its own: the cut-off turn's done covers only its own.
      await handleMindEvent(mind, {
        type: "done",
        session: "s1",
        messageId: "d1",
        covers: pi ? ["d1", "d2"] : ["d1"],
      });
      const deadline = Date.now() + 3000;
      let settled = false;
      while (!settled && Date.now() < deadline) {
        const turn = await db.select().from(turns).where(eq(turns.id, opened!.turnId)).get();
        const summary = await db
          .select()
          .from(summaries)
          .where(eq(summaries.period_key, opened!.turnId))
          .get();
        settled = pi ? !!summary : !turn;
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.ok(settled, pi ? "kept as the quiet turn it was" : "taken back as interrupted");
      await db.delete(summaries).where(eq(summaries.period_key, opened!.turnId));
    });
  }

  it("a variant's turn beside its parent's leaves the parent's typing indicator be", async () => {
    const mind = mindNamed("td-variant-typing");
    const variant = `${mind}@v`;
    delivered(mind, "s1", "d1");
    await handleMindEvent(mind, { type: "text", session: "s1", messageId: "d1", content: "p" });
    const typing = getTypingMap();
    typing.set("@bob", mind, { persistent: true });
    delivered(mind, "s1", "v1", variant);
    await handleMindEvent(
      mind,
      { type: "done", session: "s1", messageId: "v1", covers: ["v1"] },
      variant,
    );
    assert.ok(typing.get("@bob").includes(mind), "the parent is still on its turn");
  });
});

describe("a notice is told once per turn (#1233)", () => {
  async function drained(mind: string, messageId?: string, process = mind): Promise<string[]> {
    return (await drainNotices(mind, "s1", process, messageId)).map((n) => n.body);
  }

  it("a prompt folded into a running turn isn't told what the turn already drained", async () => {
    const mind = mindNamed("tn-folded");
    await notice(mind, "A");
    delivered(mind, "s1", "d1");
    assert.deepEqual(await drained(mind, "d1"), ["A"]);
    await handleMindEvent(mind, { type: "text", session: "s1", messageId: "d1", content: "a" });

    // A second message folds in; its prompt names the running turn (claude) or itself (pi,
    // codex). Either way A is already in this turn's context — but a notice that arrived
    // since is news.
    delivered(mind, "s1", "d2");
    assert.deepEqual(await drained(mind, "d1"), []);
    await notice(mind, "B");
    assert.deepEqual(await drained(mind, "d2"), ["B"]);

    await handleMindEvent(mind, {
      type: "done",
      session: "s1",
      messageId: "d1",
      covers: ["d1", "d2"],
    });
    await settled(mind, "B");
    await settled(mind, "A");
    assert.deepEqual(await bodies(mind), [], "the clean turn delivered both");
  });

  it("a notice a prompt skipped comes back if the turn that held it fails", async () => {
    // d2's drain races d1's done: A is held by d1, so d2 is shown only B. d1 then fails and
    // d2 completes clean — d2 must clear only what it showed, or A is lost unread.
    const mind = mindNamed("tn-skipped-held");
    await notice(mind, "A");
    delivered(mind, "s1", "d1");
    assert.deepEqual(await drained(mind, "d1"), ["A"]);
    await handleMindEvent(mind, { type: "text", session: "s1", messageId: "d1", content: "a" });
    delivered(mind, "s1", "d2");
    await notice(mind, "B");
    assert.deepEqual(await drained(mind, "d2"), ["B"]);

    await handleMindEvent(mind, { type: "error", session: "s1", messageId: "d1", content: "x" });
    await handleMindEvent(mind, { type: "done", session: "s1", messageId: "d1", covers: ["d1"] });
    await handleMindEvent(mind, { type: "text", session: "s1", messageId: "d2", content: "b" });
    await handleMindEvent(mind, { type: "done", session: "s1", messageId: "d2", covers: ["d2"] });
    await settled(mind, "B");

    delivered(mind, "s1", "d3");
    assert.ok((await drained(mind, "d3")).includes("A"), "A reaches the next turn");
  });

  it("a variant is told what its parent's running turn drained", async () => {
    const mind = mindNamed("tn-variant");
    const variant = `${mind}@v`;
    await notice(mind, "A");
    delivered(mind, "s1", "d1");
    assert.deepEqual(await drained(mind, "d1"), ["A"]);
    delivered(mind, "s1", "v1", variant);
    assert.deepEqual(await drained(mind, "v1", variant), ["A"], "another context entirely");
  });

  it("only a turn still running holds a notice back", async () => {
    const mind = mindNamed("tn-not-running");
    await notice(mind, "A");
    // A record left under a delivery that is no longer outstanding must not hide A forever.
    recordDrained(mind, "s1", mind, [(await drainEvents(mind, "s1"))[0].id], "gone");
    delivered(mind, "s1", "d1");
    assert.deepEqual(await drained(mind, "d1"), ["A"]);
  });

  it("a drain that names no delivery holds nothing back", async () => {
    // A notices hook that predates `messageId`: its drains key no turn, as before.
    const mind = mindNamed("tn-unkeyed");
    await notice(mind, "A");
    assert.deepEqual(await drained(mind), ["A"]);
    assert.deepEqual(await drained(mind), ["A"]);
  });
});

describe("a variant's turns are its own beside its parent's on one thread (#1177)", () => {
  it("parent and variant on the same thread each get their own turn and rows", async () => {
    const mind = mindNamed("tv-own-rows");
    const variant = `${mind}@v`;
    const db = await getDb();
    delivered(mind, "s1", "p1");
    delivered(mind, "s1", "v1", variant);
    const ev = (type: string, content: string, messageId: string, extra = {}) => ({
      type,
      session: "s1",
      messageId,
      content,
      ...extra,
    });
    // Interleaved, as two processes stream on one thread name.
    const p1 = await handleMindEvent(mind, ev("thinking", "parent thinks", "p1"));
    const v1 = await handleMindEvent(mind, ev("thinking", "variant thinks", "v1"), variant);
    const p2 = await handleMindEvent(
      mind,
      ev("tool_use", "parent tool", "p1", { metadata: { id: "tu_p" } }),
    );
    const v2 = await handleMindEvent(
      mind,
      ev("tool_use", "variant tool", "v1", { metadata: { id: "tu_v" } }),
      variant,
    );
    const v3 = await handleMindEvent(mind, ev("text", "variant says", "v1"), variant);
    const p3 = await handleMindEvent(mind, ev("text", "parent says", "p1"));

    const parentTurn = p1.turnId;
    const variantTurn = v1.turnId;
    assert.ok(parentTurn && variantTurn);
    assert.notEqual(parentTurn, variantTurn);
    for (const r of [p1, p2, p3]) assert.equal(r.turnId, parentTurn);
    for (const r of [v1, v2, v3]) assert.equal(r.turnId, variantTurn);
    for (const r of [p1, p2, p3, v1, v2, v3]) {
      const row = await db
        .select()
        .from(mindHistory)
        .where(eq(mindHistory.id, r.insertedId!))
        .get();
      assert.equal(row!.mind, mind, "history stays under the base name");
    }

    // The variant's done ends only its own turn; the parent's runs on.
    await handleMindEvent(
      mind,
      { type: "done", session: "s1", messageId: "v1", covers: ["v1"] },
      variant,
    );
    assert.equal(await turnStatus(variantTurn), "complete");
    assert.equal(getActiveTurnId(mind, "s1", mind), parentTurn);
    assert.equal(await turnStatus(parentTurn), "active");
    // And a later row of the parent's still lands on the parent's.
    const p4 = await handleMindEvent(mind, ev("text", "parent again", "p1"));
    assert.equal(p4.turnId, parentTurn);
    await handleMindEvent(mind, { type: "done", session: "s1", messageId: "p1", covers: ["p1"] });
    assert.equal(await turnStatus(parentTurn), "complete");
  });

  it("a variant's failed delivery doesn't free the thread's slot while its parent's turn runs", async () => {
    const mind = mindNamed("tv-slot");
    const variant = `${mind}@v`;
    delivered(mind, "s1", "v1", variant);
    // The parent is running a turn on the thread with no delivery of ours (an event's, say).
    await handleMindEvent(mind, { type: "text", session: "s1", content: "parent working" });
    await handleMindEvent(
      mind,
      { type: "done", session: "s1", messageId: "v1", covers: ["v1"], endsTurn: false },
      variant,
    );
    assert.equal(hasTurnSlot(mind, "s1"), true, "a turn runs on: the slot is still held");
  });

  it("a variant's turn ending doesn't free the thread's slot while its parent's turn runs", async () => {
    const mind = mindNamed("tv-slot-ends");
    const variant = `${mind}@v`;
    delivered(mind, "s1", "v1", variant);
    await handleMindEvent(mind, { type: "text", session: "s1", content: "parent working" });
    await handleMindEvent(
      mind,
      { type: "text", session: "s1", messageId: "v1", content: "v" },
      variant,
    );
    await handleMindEvent(
      mind,
      { type: "done", session: "s1", messageId: "v1", covers: ["v1"] },
      variant,
    );
    assert.equal(hasTurnSlot(mind, "s1"), true, "the parent's turn still holds it");
    // The parent's own done ends the last turn on the thread: the slot goes back.
    await handleMindEvent(mind, { type: "done", session: "s1" });
    assert.equal(hasTurnSlot(mind, "s1"), false);
  });

  it("a variant's stop frees the slot its turn was left holding", async () => {
    const mind = mindNamed("tv-slot-stop");
    const variant = `${mind}@v`;
    delivered(mind, "s1", "p1");
    await handleMindEvent(mind, { type: "text", session: "s1", messageId: "p1", content: "p" });
    await handleMindEvent(mind, { type: "text", session: "s1", content: "v" }, variant);
    await handleMindEvent(mind, { type: "done", session: "s1", messageId: "p1", covers: ["p1"] });
    assert.equal(hasTurnSlot(mind, "s1"), true, "left to the variant's turn");
    dm.releaseStopped(variant, await clearMind(variant));
    assert.equal(hasTurnSlot(mind, "s1"), false);
  });

  it("a variant's stop drops its deliveries, freeing the slot and the typing indicator", async () => {
    const mind = mindNamed("tv-stop-delivery");
    const variant = `${mind}@v`;
    delivered(mind, "s1", "p1");
    await handleMindEvent(mind, { type: "text", session: "s1", messageId: "p1", content: "p" });
    delivered(mind, "s1", "v1", variant);
    await handleMindEvent(
      mind,
      { type: "text", session: "s1", messageId: "v1", content: "v" },
      variant,
    );
    const typing = getTypingMap();
    typing.set("@bob", mind, { persistent: true });
    await handleMindEvent(mind, { type: "done", session: "s1", messageId: "p1", covers: ["p1"] });
    assert.ok(typing.get("@bob").includes(mind), "the variant is still on its turn");
    // It stops without a done for v1.
    dm.releaseStopped(variant, await clearMind(variant));
    assert.equal(dm.isSessionBusy(mind, "s1"), false);
    assert.equal(hasTurnSlot(mind, "s1"), false);
    assert.ok(!typing.get("@bob").includes(mind));
  });

  it("a turn beside that has gone quiet past a slot's lifetime holds nothing", async () => {
    const mind = mindNamed("tv-slot-quiet");
    const variant = `${mind}@v`;
    delivered(mind, "s1", "p1");
    await handleMindEvent(mind, { type: "text", session: "s1", messageId: "p1", content: "p" });
    await handleMindEvent(mind, { type: "text", session: "s1", content: "v" }, variant);
    const typing = getTypingMap();
    typing.set("@bob", mind, { persistent: true });
    const realNow = Date.now;
    Date.now = () => realNow() + 31 * 60_000;
    try {
      await handleMindEvent(mind, { type: "done", session: "s1", messageId: "p1", covers: ["p1"] });
    } finally {
      Date.now = realNow;
    }
    assert.equal(hasTurnSlot(mind, "s1"), false);
    assert.ok(!typing.get("@bob").includes(mind));
  });

  it("a turn beside that is still being heard from holds the slot, however old", async () => {
    const mind = mindNamed("tv-slot-heard");
    const variant = `${mind}@v`;
    delivered(mind, "s1", "p1");
    await handleMindEvent(mind, { type: "text", session: "s1", messageId: "p1", content: "p" });
    await handleMindEvent(mind, { type: "text", session: "s1", content: "v" }, variant);
    const realNow = Date.now;
    Date.now = () => realNow() + 31 * 60_000;
    try {
      await handleMindEvent(mind, { type: "tool_use", session: "s1", content: "still" }, variant);
      await handleMindEvent(mind, { type: "done", session: "s1", messageId: "p1", covers: ["p1"] });
    } finally {
      Date.now = realNow;
    }
    assert.equal(hasTurnSlot(mind, "s1"), true);
  });

  it("an interrupted turn's message goes to its own process's next turn, never the other's", async () => {
    const mind = mindNamed("tv-interrupted");
    const variant = `${mind}@v`;
    const db = await getDb();
    const row = async (content: string) =>
      (
        await db
          .insert(mindHistory)
          .values({ mind, type: "inbound", channel: "@alice", sender: "alice", content })
          .returning({ id: mindHistory.id })
      )[0].id;
    const cutOff = await row("cut off");
    await holdInterrupted(mind, "s1", variant, [cutOff]);

    // The parent's turn, opened for a message of its own, does not take the variant's.
    const forParent = await row("for the parent");
    (dm as any).addOutstanding(mind, "s1", "p1", mind, undefined, undefined, [forParent]);
    const p = await handleMindEvent(mind, { type: "text", session: "s1", content: "p" });
    // The variant's, opened by its first event for the interrupting message, does.
    const interrupting = await row("interrupting");
    (dm as any).addOutstanding(mind, "s1", "v2", variant, undefined, undefined, [interrupting]);
    const v = await handleMindEvent(mind, { type: "text", session: "s1", content: "v" }, variant);

    const turnOf = async (id: number) =>
      (await db.select().from(mindHistory).where(eq(mindHistory.id, id)).get())!.turn_id;
    assert.equal(await turnOf(forParent), p.turnId);
    assert.equal(await turnOf(interrupting), v.turnId, "its trigger, linked exactly");
    assert.equal(await turnOf(cutOff), v.turnId);
  });
});

describe("error and drain state only for threads the daemon knows (#1220)", () => {
  it("an error on a thread with no delivery or turn keeps one stray record per process", async () => {
    const mind = mindNamed("te-stray-error");
    await handleMindEvent(mind, { type: "error", session: "made-up-1", content: "boom" });
    await handleMindEvent(mind, { type: "error", session: "made-up-2", content: "boom" });
    // Naming threads doesn't grow it: the second replaced the first.
    assert.equal(takeErrored(mind, "made-up-1", mind), false);
    assert.equal(takeErrored(mind, "made-up-2", mind), true);
    // A variant's error naming its parent's delivery is the variant's, never the parent's.
    delivered(mind, "s1", "d1");
    await handleMindEvent(
      mind,
      { type: "error", session: "s1", messageId: "d1", content: "boom" },
      `${mind}@v`,
    );
    assert.equal(takeErrored(mind, "s1", mind, ["d1"]), false, "not keyed to the parent's");
    assert.equal(takeErrored(mind, "s1", `${mind}@v`), true);
  });

  it("a delivery a done has covered no longer counts as outstanding, while it is recorded", async () => {
    const mind = mindNamed("te-retiring");
    delivered(mind, "s1", "d1");
    assert.equal(dm.isOutstanding(mind, "s1", "d1", mind), true);
    assert.equal(dm.hasOutstanding(mind, "s1", mind), true);
    dm.markRetiring(mind, "s1", ["d1"]);
    assert.equal(dm.isOutstanding(mind, "s1", "d1", mind), false);
    assert.equal(dm.hasOutstanding(mind, "s1", mind), false);
  });

  it("an error handled after its turn's done flags nothing that runs next", async () => {
    // The mind POSTs a turn's `error` and `done` concurrently (#1298); the done won.
    const mind = mindNamed("te-late-error");
    delivered(mind, "s1", "d1");
    await handleMindEvent(mind, { type: "text", session: "s1", messageId: "d1", content: "a" });
    await handleMindEvent(mind, { type: "done", session: "s1", messageId: "d1", covers: ["d1"] });
    await handleMindEvent(mind, { type: "error", session: "s1", messageId: "d1", content: "x" });
    await notice(mind, "A");
    delivered(mind, "s1", "d2");
    await drainNotices(mind, "s1", mind, "d2");
    await handleMindEvent(mind, { type: "text", session: "s1", messageId: "d2", content: "b" });
    await handleMindEvent(mind, { type: "done", session: "s1", messageId: "d2", covers: ["d2"] });
    await settled(mind, "A");
    assert.ok(!(await bodies(mind)).includes("A"), "the next turn ran clean");
  });

  it("an error naming no delivery still flags a thread its process has a delivery on", async () => {
    // A template that predates `messageId` on errors: failure notices still accumulate.
    const mind = mindNamed("te-legacy");
    delivered(mind, "s1", "d1");
    await handleMindEvent(mind, { type: "error", session: "s1", content: "boom" });
    assert.equal(takeErrored(mind, "s1", mind, ["d1"]), true);
  });

  it("a folded event run as its own turn delivers what it drained before that turn opened", async () => {
    // The event folded in, so it has no delivery and no turn yet when its prompt drains.
    const mind = mindNamed("te-stray-drain");
    await notice(mind, "A");
    assert.deepEqual(
      (await drainNotices(mind, "s1", mind)).map((n) => n.body),
      ["A"],
    );
    await handleMindEvent(mind, { type: "text", session: "s1", content: "on it" });
    await handleMindEvent(mind, { type: "done", session: "s1" });
    await settled(mind, "A");
    assert.deepEqual(await bodies(mind), [], "the clean turn delivered it");
  });

  it("a folded event's turn that failed before it opened keeps what it drained", async () => {
    const mind = mindNamed("te-stray-failed");
    await notice(mind, "A");
    await drainNotices(mind, "s1", mind);
    await handleMindEvent(mind, { type: "error", session: "s1", content: "boom" });
    await handleMindEvent(mind, { type: "text", session: "s1", content: "sorry" });
    await handleMindEvent(mind, { type: "done", session: "s1" });
    await new Promise((r) => setTimeout(r, 150));
    assert.ok((await bodies(mind)).includes("A"), "an errored turn delivers nothing");
  });

  it("a stray record left past a slot's lifetime is no later turn's", async () => {
    const mind = mindNamed("te-stray-stale");
    await handleMindEvent(mind, { type: "error", session: "s1", content: "boom" });
    const realNow = Date.now;
    Date.now = () => realNow() + 31 * 60_000;
    try {
      assert.equal(takeErrored(mind, "s1", mind), false);
    } finally {
      Date.now = realNow;
    }
  });

  it("stray drains are bounded: another thread's replaces the last", async () => {
    const mind = mindNamed("te-stray-bound");
    await notice(mind, "A");
    await drainNotices(mind, "s1", mind);
    await drainNotices(mind, "s2", mind);
    assert.deepEqual(takeDrained(mind, "s1", mind), []);
  });
});
