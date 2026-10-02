import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { getOrCreateMindUser } from "../packages/daemon/src/lib/auth.js";
import {
  initMindManager,
  tryGetMindManager,
} from "../packages/daemon/src/lib/daemon/mind-manager.js";
import {
  generateMindToken,
  revokeMindToken,
} from "../packages/daemon/src/lib/daemon/mind-tokens.js";
import { handleMindEvent } from "../packages/daemon/src/lib/daemon/turn-lifecycle.js";
import { acquireTurnSlot, releaseTurnSlot } from "../packages/daemon/src/lib/daemon/turn-slots.js";
import {
  clearMind,
  completeTurn,
  createTurn,
  getActiveTurnId,
} from "../packages/daemon/src/lib/daemon/turn-tracker.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  clearEchoTextCache,
  echoTextToChannel,
} from "../packages/daemon/src/lib/delivery/echo-text.js";
import { recordOutbound, turnStamp } from "../packages/daemon/src/lib/delivery/message-delivery.js";
import { createConversation } from "../packages/daemon/src/lib/events/conversations.js";
import {
  type MindEvent,
  subscribe as subscribeMind,
} from "../packages/daemon/src/lib/events/mind-events.js";
import { addMind, addVariant, mindDir } from "../packages/daemon/src/lib/mind/registry.js";
import {
  conversations,
  messages,
  mindHistory,
  minds,
  turns,
  users,
} from "../packages/daemon/src/lib/schema.js";
import { invalidateMindUserCache } from "../packages/daemon/src/web/middleware/auth.js";

// A send must be stamped with the exact thread and turn that made it, or with neither —
// never a sibling thread's turn (#1173). On bardo a send from pip's `main` thread was
// recorded under the concurrently running `#bardo` turn, and the "since you were last
// here" note (#939) built from these rows would have told pip a false thing about itself.

const MIND = "attr-pip";
const PEER = "attr-peer";
const VARIANT = "attr-pip-v";

let convId: string | undefined;

async function cleanup() {
  revokeMindToken(MIND);
  revokeMindToken(VARIANT);
  releaseTurnSlot(MIND);
  await clearMind(MIND);
  const db = await getDb();
  if (convId) {
    await db.delete(messages).where(eq(messages.conversation_id, convId));
    await db.delete(conversations).where(eq(conversations.id, convId));
    convId = undefined;
  }
  for (const m of [VARIANT, MIND, PEER]) {
    await db.delete(mindHistory).where(eq(mindHistory.mind, m));
    await db.delete(turns).where(eq(turns.mind, m));
    await db.delete(minds).where(eq(minds.name, m));
    await db.delete(users).where(eq(users.username, m));
    invalidateMindUserCache(m);
  }
}

async function setup(): Promise<string> {
  // fan-out (invoked by the chat handler) needs a MindManager instance.
  if (!tryGetMindManager()) initMindManager();
  await addMind(MIND, 4171);
  await addMind(PEER, 4172);
  const a = await getOrCreateMindUser(MIND);
  const b = await getOrCreateMindUser(PEER);
  const conv = await createConversation({ participantIds: [a.id, b.id] });
  convId = conv.id;
  return generateMindToken(MIND);
}

async function app() {
  return (await import("../packages/daemon/src/web/app.js")).default as unknown as {
    request: typeof fetch;
  };
}

function post(path: string, token: string, body: unknown, thread?: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Origin: "http://localhost",
    "Content-Type": "application/json",
  };
  if (thread) headers["X-Volute-Thread"] = thread;
  return app().then((a) =>
    a.request(`http://localhost${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    } as RequestInit),
  );
}

async function send(token: string, message: string, thread?: string) {
  const res = await post("/api/v1/chat", token, { conversationId: convId, message }, thread);
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as { outboundId?: number };
}

async function outboundRow(content: string) {
  const db = await getDb();
  const rows = await db.select().from(mindHistory).where(eq(mindHistory.mind, MIND)).all();
  const row = rows.find((r) => r.type === "outbound" && r.content === content);
  assert.ok(row, `outbound "${content}" should be recorded`);
  return row!;
}

describe("send attribution: exact thread and turn, or none (#1173)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("stamps each of two concurrently active threads' sends with its own turn and thread", async () => {
    const token = await setup();
    await handleMindEvent(MIND, { type: "tool_use", session: "main", content: "m" });
    await handleMindEvent(MIND, { type: "tool_use", session: "#bardo", content: "b" });
    const turnMain = getActiveTurnId(MIND, "main");
    const turnBardo = getActiveTurnId(MIND, "#bardo");
    assert.ok(turnMain && turnBardo && turnMain !== turnBardo);

    await send(token, "from main", "main");
    await send(token, "from bardo", "#bardo");

    const fromMain = await outboundRow("from main");
    assert.equal(fromMain.turn_id, turnMain);
    assert.equal(fromMain.thread, "main");
    const fromBardo = await outboundRow("from bardo");
    assert.equal(fromBardo.turn_id, turnBardo);
    assert.equal(fromBardo.thread, "#bardo");
  });

  it("never credits a send to a sibling turn still in the sessionless slot", async () => {
    const token = await setup();
    // A sibling thread's turn mid-creation: created, not yet re-keyed to its session.
    // `main` has no active turn of its own (its first event hasn't landed yet).
    const sibling = await createTurn(MIND);
    assert.ok(sibling);

    await send(token, "main, early", "main");
    await send(token, "no header");

    for (const [content, thread] of [
      ["main, early", "main"],
      ["no header", null],
    ] as const) {
      const row = await outboundRow(content);
      assert.equal(row.turn_id, null, `"${content}" must not carry the sibling's turn`);
      assert.equal(row.thread, thread, "the sending thread is recorded even without a turn");
    }
  });

  it("a send naming a thread mid-delivery opens no turn there (#1298)", async () => {
    const token = await setup();
    // The daemon holds a slot on `@admin` — a delivery is in flight there — but no turn is
    // open on it yet. A send naming that thread must not open one, or attach to it.
    acquireTurnSlot(MIND, "@admin");
    await send(token, "naming another thread", "@admin");
    assert.equal(getActiveTurnId(MIND, "@admin"), undefined);
    const db = await getDb();
    assert.equal((await db.select().from(turns).where(eq(turns.mind, MIND)).all()).length, 0);
    assert.equal((await outboundRow("naming another thread")).turn_id, null);
  });

  it("an unstamped send is linked to its own thread and turn by its tool_result marker", async () => {
    const token = await setup();
    // A sibling turn in the sessionless slot that is never assigned a thread: the
    // sending thread's tool_result must still link to the sending thread's own turn.
    const sibling = await createTurn(MIND);
    const { outboundId } = await send(token, "main, linked later", "main");
    assert.ok(outboundId != null);

    await handleMindEvent(MIND, {
      type: "tool_result",
      session: "main",
      content: `Message sent.\n[volute:outbound:${outboundId}]`,
    });
    const turnMain = getActiveTurnId(MIND, "main");
    assert.ok(turnMain && turnMain !== sibling);

    const row = await outboundRow("main, linked later");
    assert.equal(row.turn_id, turnMain);
    assert.equal(row.thread, "main");
  });

  it("a send's marker echoed into another thread never credits it to that thread", async () => {
    const token = await setup();
    await handleMindEvent(MIND, { type: "tool_use", session: "#bardo", content: "b" });
    const turnBardo = getActiveTurnId(MIND, "#bardo");
    // main has no active turn yet, so the send is recorded with its thread and no turn.
    const { outboundId } = await send(token, "main's words", "main");
    const marker = `[volute:outbound:${outboundId}]`;

    // #bardo reads a log the marker was written to, before main's own tool_result lands.
    await handleMindEvent(MIND, { type: "tool_result", session: "#bardo", content: marker });
    let row = await outboundRow("main's words");
    assert.equal(row.turn_id, null, "not credited to #bardo's turn");
    assert.equal(row.thread, "main");

    await handleMindEvent(MIND, { type: "tool_result", session: "main", content: marker });
    const turnMain = getActiveTurnId(MIND, "main");
    assert.ok(turnMain && turnMain !== turnBardo);
    row = await outboundRow("main's words");
    assert.equal(row.turn_id, turnMain);
    assert.equal(row.thread, "main");
  });

  it("turnStamp: a thread's own turn, the thread alone, or nothing", async () => {
    await handleMindEvent(MIND, { type: "tool_use", session: "main", content: "m" });
    await handleMindEvent(MIND, { type: "tool_use", content: "bare" });
    const turnMain = getActiveTurnId(MIND, "main");
    assert.ok(turnMain && getActiveTurnId(MIND));

    assert.deepEqual(turnStamp(MIND, "main"), { turnId: turnMain, thread: "main" });
    assert.deepEqual(turnStamp(MIND, "#quiet"), { thread: "#quiet" });
    // A send with no thread is of unknown origin: never the sessionless stream's turn.
    assert.deepEqual(turnStamp(MIND, undefined), {});
    assert.deepEqual(turnStamp(MIND, ""), {});
  });

  it("an echo keeps its text event's own turn, even once a done has closed it", async () => {
    await setup();
    const configDir = resolve(mindDir(MIND), "home/.config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(resolve(configDir, "volute.json"), JSON.stringify({ echoText: true }));
    clearEchoTextCache(MIND);
    try {
      const { turnId } = await handleMindEvent(MIND, {
        type: "tool_use",
        session: "main",
        content: "m",
      });
      assert.ok(turnId);
      await completeTurn(MIND, "main"); // the done lands before the echo runs
      await echoTextToChannel(MIND, `@${PEER}`, "echoed", { turnId, thread: "main" }, undefined);
      const row = await outboundRow("echoed");
      assert.equal(row.turn_id, turnId);
      assert.equal(row.thread, "main");
    } finally {
      clearEchoTextCache(MIND);
      rmSync(mindDir(MIND), { recursive: true, force: true });
    }
  });

  it("publishes a send at once, and again with its turn when its marker links it", async () => {
    const token = await setup();
    const events: MindEvent[] = [];
    const unsub = subscribeMind(MIND, (e) => events.push(e));
    try {
      const { outboundId } = await send(token, "no turn yet", "main");
      await handleMindEvent(MIND, {
        type: "tool_result",
        session: "main",
        content: `[volute:outbound:${outboundId}]`,
      });
    } finally {
      unsub();
    }
    const turnMain = getActiveTurnId(MIND, "main");
    const outbound = events.filter((e) => e.type === "outbound");
    assert.deepEqual(
      outbound.map((e) => e.turnId),
      [undefined, turnMain],
    );
    assert.equal((await outboundRow("no turn yet")).turn_id, turnMain);
  });

  it('a "*" thread is no thread: it can\'t claim the sessionless turn', async () => {
    const token = await setup();
    await handleMindEvent(MIND, { type: "tool_use", content: "bare" });
    assert.ok(getActiveTurnId(MIND));
    await send(token, "star", "*");
    const row = await outboundRow("star");
    assert.equal(row.turn_id, null);
    assert.equal(row.thread, null);
    assert.deepEqual(turnStamp(MIND, "*"), {});
  });

  it("a variant never borrows its parent's turn on a shared thread name, or the reverse", async () => {
    await setup();
    await addVariant(VARIANT, MIND, 4173, "/tmp/attr-variant", "attr-branch");
    // The parent's `main` turn: the variant's own `main` shares its key.
    await handleMindEvent(MIND, { type: "tool_use", session: "main", content: "p" });
    const parentTurn = getActiveTurnId(MIND, "main");
    assert.ok(parentTurn);

    assert.deepEqual(turnStamp(MIND, "main", MIND), { turnId: parentTurn, thread: "main" });
    assert.deepEqual(turnStamp(MIND, "main", VARIANT), { thread: "main" });

    // An external send from the variant's `main`: thread recorded, no turn.
    const vtoken = generateMindToken(VARIANT);
    const res = await post(
      `/api/v1/minds/${VARIANT}/history`,
      vtoken,
      { channel: "discord:x/y", content: "variant ext" },
      "main",
    );
    assert.equal(res.status, 200);
    const ext = await outboundRow("variant ext");
    assert.equal(ext.turn_id, null, "not the parent's turn");
    assert.equal(ext.thread, "main");

    // A variant send awaiting its marker: the variant's tool_result lands on the parent's
    // turn key, and must not claim the send into the parent's turn.
    const early = await recordOutbound(VARIANT, "@x", "variant early", { thread: "main" });
    await handleMindEvent(
      MIND,
      { type: "tool_result", session: "main", content: `[volute:outbound:${early}]` },
      VARIANT,
    );
    const db = await getDb();
    let row = await db.select().from(mindHistory).where(eq(mindHistory.id, early!)).get();
    assert.equal(row!.turn_id, null);

    // Once the variant's own turn exists on that key, its marker claims its own send.
    await completeTurn(MIND, "main");
    await handleMindEvent(MIND, { type: "tool_use", session: "main", content: "v" }, VARIANT);
    const variantTurn = getActiveTurnId(MIND, "main");
    await handleMindEvent(
      MIND,
      { type: "tool_result", session: "main", content: `[volute:outbound:${early}]` },
      VARIANT,
    );
    row = await db.select().from(mindHistory).where(eq(mindHistory.id, early!)).get();
    assert.equal(row!.turn_id, variantTurn);
    assert.deepEqual(turnStamp(MIND, "main", MIND), { thread: "main" }, "nor the reverse");
  });

  it("an external send recorded via POST /:name/history is stamped exactly too", async () => {
    const token = await setup();
    await handleMindEvent(MIND, { type: "tool_use", session: "#bardo", content: "b" });
    const turnBardo = getActiveTurnId(MIND, "#bardo");
    await createTurn(MIND); // another sibling, sessionless

    const path = `/api/v1/minds/${MIND}/history`;
    let res = await post(path, token, { channel: "discord:x/y", content: "ext bardo" }, "#bardo");
    assert.equal(res.status, 200);
    res = await post(path, token, { channel: "discord:x/y", content: "ext main" }, "main");
    assert.equal(res.status, 200);

    const bardo = await outboundRow("ext bardo");
    assert.equal(bardo.turn_id, turnBardo);
    assert.equal(bardo.thread, "#bardo");
    const main = await outboundRow("ext main");
    assert.equal(main.turn_id, null);
    assert.equal(main.thread, "main");
  });
});
