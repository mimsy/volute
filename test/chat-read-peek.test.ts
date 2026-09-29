import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { eq, inArray } from "drizzle-orm";
import { getOrCreateMindUser } from "../packages/daemon/src/lib/auth.js";
import {
  generateMindToken,
  issueScriptToken,
  revokeMindToken,
} from "../packages/daemon/src/lib/daemon/mind-tokens.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  DeliveryManager,
  initDeliveryManager,
  tryGetDeliveryManager,
} from "../packages/daemon/src/lib/delivery/delivery-manager.js";
import { clearConfigCache } from "../packages/daemon/src/lib/delivery/delivery-router.js";
import { addMessage, createConversation } from "../packages/daemon/src/lib/events/conversations.js";
import { addMind, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import { deliveryQueue, minds, users } from "../packages/daemon/src/lib/schema.js";
import { invalidateMindUserCache } from "../packages/daemon/src/web/middleware/auth.js";

// A message a mind already read with `volute chat read` while it waited in the queue — in a
// batch buffer behind a busy turn — arrives marked as peeked, not looking new. pip on bardo
// read four #system messages mid-turn and then spent a whole turn on the batch that
// delivered the same four, unlabeled.

// Sorts after any real timestamp in the queue: nothing before it counts as shown.
const EPOCH = "1970-01-01 00:00:00";

async function queueRows(mind: string) {
  const db = await getDb();
  return (await db.select().from(deliveryQueue).where(eq(deliveryQueue.mind, mind))).sort(
    (a, b) => a.id - b.id,
  );
}

function writeRoutes(name: string, config: object): void {
  const dir = resolve(process.env.VOLUTE_HOME!, "minds", name, "home/.config");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "routes.json"), JSON.stringify(config));
  clearConfigCache(name);
}

// Long timers: a message stays in the buffer until the `@now` trigger flushes it.
const BATCH = {
  rules: [{ channel: "#room", thread: "room" }],
  threads: {
    room: { delivery: { mode: "batch", debounce: 600, maxWait: 600, triggers: ["@now"] } },
  },
  gateUnmatched: false,
};

describe("DeliveryManager.notePeekedInConversation", () => {
  let manager: DeliveryManager | undefined;
  const servers: Server[] = [];
  const cleanup: string[] = [];

  afterEach(async () => {
    manager?.dispose();
    manager = undefined;
    for (const s of servers.splice(0)) s.close();
    const db = await getDb();
    for (const n of cleanup.splice(0)) {
      await db.delete(deliveryQueue).where(eq(deliveryQueue.mind, n));
      removeMind(n);
    }
    clearConfigCache();
  });

  async function setup(): Promise<{ name: string; received: string[] }> {
    const received: string[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
      });
      req.on("end", () => {
        received.push(raw);
        res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
      });
    });
    servers.push(server);
    const port: number = await new Promise((r) => {
      server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port));
    });
    const name = `read-peek-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await addMind(name, port);
    cleanup.push(name);
    writeRoutes(name, BATCH);
    manager = new DeliveryManager();
    return { name, received };
  }

  const send = (name: string, content: string, conversationId = "conv-room") =>
    manager!.routeAndDeliver(name, {
      channel: "#room",
      sender: "gardener",
      senderId: null,
      content,
      conversationId,
    });

  it("marks a buffered message the mind read, and delivers it prefaced", async () => {
    const { name, received } = await setup();
    await send(name, "a threshold between dusk and dawn");
    assert.equal((await queueRows(name)).length, 1, "waiting in the buffer");

    await manager!.notePeekedInConversation({ name, thread: "room" }, "conv-room", EPOCH);
    const [row] = await queueRows(name);
    assert.equal(row.peeked_thread, "room");
    assert.equal(row.status, "pending", "reading changes nothing about delivery");

    await send(name, "@now new since the read");
    const start = Date.now();
    while (received.length === 0 && Date.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const body = received.join("\n");
    assert.match(
      body,
      /\[peeked — you peeked this from thread \\"room\\" at [^\]]+\]\\na threshold between dusk and dawn/,
    );
    assert.ok(
      !/\[peeked[^\]]*\]\\n@now new since the read/.test(body),
      "a message that arrived after the read is not marked",
    );
  });

  it("marks only the reader's rows, from that conversation, shown in the read", async () => {
    const { name } = await setup();
    await send(name, "before the page the mind read");
    await send(name, "another conversation", "conv-other");
    await send(name, "for a variant");
    await send(name, "on the page");
    const db = await getDb();
    const [older, other, toVariant, shown] = await queueRows(name);
    await db
      .update(deliveryQueue)
      .set({ created_at: "2000-01-01 00:00:00" })
      .where(eq(deliveryQueue.id, older.id));
    await db
      .update(deliveryQueue)
      .set({ target_mind: `${name}-exp` })
      .where(eq(deliveryQueue.id, toVariant.id));

    await manager!.notePeekedInConversation(
      { name, thread: "room" },
      "conv-room",
      shown.created_at,
    );

    const byId = new Map((await queueRows(name)).map((r) => [r.id, r.peeked_thread]));
    assert.equal(byId.get(shown.id), "room");
    assert.equal(byId.get(older.id), null, "older than anything the read returned");
    assert.equal(byId.get(other.id), null, "a different conversation");
    assert.equal(byId.get(toVariant.id), null, "addressed to a variant, not the reader");
  });
});

describe("GET /minds/:name/conversations/:id/messages notes a mind's read", () => {
  const MIND = "chat-read-peek-mind";
  let convId = "";

  async function cleanupAll() {
    revokeMindToken(MIND);
    const db = await getDb();
    await db.delete(deliveryQueue).where(eq(deliveryQueue.mind, MIND));
    await db.delete(users).where(inArray(users.username, [MIND]));
    await db.delete(minds).where(inArray(minds.name, [MIND]));
  }

  before(async () => {
    await cleanupAll();
    if (!tryGetDeliveryManager()) initDeliveryManager();
    const mindUser = await getOrCreateMindUser(MIND);
    await addMind(MIND, 4763);
    invalidateMindUserCache(MIND);
    const conv = await createConversation({ participantIds: [mindUser.id], type: "channel" });
    convId = conv.id;
    await addMessage(convId, "user", "gardener", [{ type: "text", text: "hello room" }]);
  });

  after(cleanupAll);

  async function pendingRow(): Promise<number> {
    const db = await getDb();
    await db.delete(deliveryQueue).where(eq(deliveryQueue.mind, MIND));
    const [row] = await db
      .insert(deliveryQueue)
      .values({
        mind: MIND,
        thread: "room",
        channel: "#room",
        sender: "gardener",
        status: "pending",
        payload: JSON.stringify({
          channel: "#room",
          sender: "gardener",
          senderId: null,
          content: "hello room",
          conversationId: convId,
        }),
        // After the message it stands for, so any read that returned that message showed it.
        created_at: "2999-01-01 00:00:00",
      })
      .returning({ id: deliveryQueue.id });
    return row.id;
  }

  async function read(headers: Record<string, string>, query = "limit=10") {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(
      `http://localhost/api/v1/minds/${MIND}/conversations/${convId}/messages?${query}`,
      { headers: { Origin: "http://localhost", ...headers } },
    );
    assert.equal(res.status, 200, await res.clone().text());
  }

  async function peekedThread(id: number) {
    const db = await getDb();
    const [row] = await db.select().from(deliveryQueue).where(eq(deliveryQueue.id, id));
    return row.peeked_thread;
  }

  it("stamps the thread the mind read from", async () => {
    const id = await pendingRow();
    await read({ Authorization: `Bearer ${generateMindToken(MIND)}`, "X-Volute-Thread": "main" });
    assert.equal(await peekedThread(id), "main");
  });

  it("does not stamp a script's read, or a read from no thread", async () => {
    let id = await pendingRow();
    await read({ Authorization: `Bearer ${issueScriptToken(MIND)}`, "X-Volute-Thread": "main" });
    assert.equal(await peekedThread(id), null, "its output may never reach the mind");

    id = await pendingRow();
    await read({ Authorization: `Bearer ${generateMindToken(MIND)}` });
    assert.equal(await peekedThread(id), null);
  });

  it("does not stamp a read of an older page", async () => {
    const id = await pendingRow();
    await read(
      { Authorization: `Bearer ${generateMindToken(MIND)}`, "X-Volute-Thread": "main" },
      "limit=10&before=999999999",
    );
    assert.equal(await peekedThread(id), null);
  });
});
