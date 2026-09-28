import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { drainEvents, recordNotice } from "../packages/daemon/src/lib/chat/system-events.js";
import { getTypingMap } from "../packages/daemon/src/lib/chat/typing.js";
import {
  handleMindEvent,
  setNoticeDrainWatermark,
} from "../packages/daemon/src/lib/daemon/turn-lifecycle.js";
import { hasTurnSlot } from "../packages/daemon/src/lib/daemon/turn-slots.js";
import {
  clearMind,
  getActiveTurnId,
  markErrored,
  takeDrainWatermark,
  takeErrored,
} from "../packages/daemon/src/lib/daemon/turn-tracker.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  type DeliveryManager,
  initDeliveryManager,
} from "../packages/daemon/src/lib/delivery/delivery-manager.js";
import { mindHistory, systemEvents, turns } from "../packages/daemon/src/lib/schema.js";

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

    assert.equal(getActiveTurnId(mind, "s1"), undefined, "the turn should be closed");
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
    const a = await notice(mind, "A");
    delivered(mind, "s1", "d1");
    setNoticeDrainWatermark(mind, "s1", a, "d1");
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
    const a = await notice(mind, "A");
    delivered(mind, "s1", "d1");
    setNoticeDrainWatermark(mind, "s1", a, "d1");
    await handleMindEvent(mind, { type: "text", session: "s1", messageId: "d1", content: "N" });

    // d2 was queued behind N. Its turn's drain of B lands before N's done is even handled.
    delivered(mind, "s1", "d2");
    const b = await notice(mind, "B");
    setNoticeDrainWatermark(mind, "s1", b, "d2");
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

    assert.equal(getActiveTurnId(mind, "s1"), turnId, "the running turn is untouched");
    assert.equal(dm.isSessionBusy(mind, "s1"), true, "d1 is still running");
    assert.equal(hasTurnSlot(mind, "s1"), true);

    // d2's error was d2's: the running turn still completes clean and clears its drain.
    const a = await notice(mind, "A");
    setNoticeDrainWatermark(mind, "s1", a, "d1");
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
    assert.equal(getActiveTurnId(mind, "s1"), turnId);
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
    assert.equal(getActiveTurnId(mind, "s1"), turnId);
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
    const a = await notice(mind, "A");
    setNoticeDrainWatermark(mind, "s1", a, "d1");
    await handleMindEvent(mind, { type: "error", session: "s1", messageId: "d1", content: "e" });

    // A bare done from an un-upgraded variant: it covers only the variant's own.
    await handleMindEvent(mind, { type: "done", session: "s1", messageId: "v1" }, variant);
    assert.equal(getActiveTurnId(mind, "s1"), turnId, "the parent's turn runs on");
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
    const a = await notice(mind, "A");
    setNoticeDrainWatermark(mind, "s1", a);
    await handleMindEvent(mind, { type: "done", session: "s1", messageId: "d1" });
    assert.equal(await turnStatus(turnId!), "complete");
    assert.equal(dm.isSessionBusy(mind, "s1"), false);
    assert.equal(hasTurnSlot(mind, "s1"), false);
    await settled(mind, "A");
    assert.deepEqual(await bodies(mind), []);
  });

  it("a mind's stop forgets the drain watermarks and error flags of turns that never ended", async () => {
    const mind = mindNamed("td-stop");
    setNoticeDrainWatermark(mind, "s1", 7, "d1");
    markErrored(mind, "s1", "d1");
    await clearMind(mind);
    assert.equal(takeDrainWatermark(mind, "s1"), undefined);
    assert.equal(takeErrored(mind, "s1"), false);
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
    const a = await notice(mind, "A");
    setNoticeDrainWatermark(mind, "s1", a, "v1");
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
    assert.equal(getActiveTurnId(mind, "s1"), turnId, "the parent's turn runs on");
    assert.equal(await turnStatus(turnId!), "active");
  });

  it("an id the daemon never delivered keys nothing of its own", async () => {
    // Minds are untrusted: an error or drain naming an id that isn't an outstanding
    // delivery is read as naming no turn, so it can't grow per-delivery state — and it
    // still counts against the session's next turn.
    const mind = mindNamed("td-bogus-ids");
    delivered(mind, "s1", "d1");
    await handleMindEvent(mind, { type: "text", session: "s1", messageId: "d1", content: "a" });
    const a = await notice(mind, "A");
    setNoticeDrainWatermark(mind, "s1", a, "made-up-1");
    await handleMindEvent(mind, {
      type: "error",
      session: "s1",
      messageId: "made-up-2",
      content: "x",
    });
    await handleMindEvent(mind, { type: "done", session: "s1", messageId: "d1", covers: ["d1"] });
    assert.equal(takeDrainWatermark(mind, "s1"), undefined, "the drain went to d1's turn");
    assert.equal(takeErrored(mind, "s1"), false, "and so did the error");
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
