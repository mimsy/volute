import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq, inArray } from "drizzle-orm";
import {
  createUser,
  getOrCreateMindUser,
  getOrCreateSystemUser,
} from "../packages/daemon/src/lib/auth.js";
import {
  generateMindToken,
  issueScriptToken,
  revokeMindToken,
} from "../packages/daemon/src/lib/daemon/mind-tokens.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  initDeliveryManager,
  tryGetDeliveryManager,
} from "../packages/daemon/src/lib/delivery/delivery-manager.js";
import { addMind, addSpirit } from "../packages/daemon/src/lib/mind/registry.js";
import { deliveryQueue, minds, users } from "../packages/daemon/src/lib/schema.js";
import {
  createSession,
  invalidateMindUserCache,
} from "../packages/daemon/src/web/middleware/auth.js";

// A peek notes which thread the mind looked from, so the message arrives prefaced when its
// channel is routed (#1172). Only the mind itself looking from a thread counts, not a host on the
// dashboard.

const MIND = "peek-reader-mind";
const SPIRIT = "volute"; // the default spirit name; it authenticates as the system user
const ADMIN = "peek-reader-admin";
const CHANNEL = "@peek-reader-stranger";

async function cleanup() {
  for (const m of [MIND, SPIRIT]) revokeMindToken(m);
  const db = await getDb();
  await db.delete(deliveryQueue).where(inArray(deliveryQueue.mind, [MIND, SPIRIT]));
  await db.delete(users).where(inArray(users.username, [MIND, SPIRIT, ADMIN]));
  await db.delete(minds).where(inArray(minds.name, [MIND, SPIRIT]));
}

async function hold(mind: string) {
  const db = await getDb();
  await db.delete(deliveryQueue).where(eq(deliveryQueue.mind, mind));
  // No routes.json → every channel is unmatched and gating holds the message.
  await tryGetDeliveryManager()!.routeAndDeliver(mind, {
    channel: CHANNEL,
    sender: "stranger",
    content: "hello?",
  });
}

async function heldRow(mind: string) {
  const db = await getDb();
  const rows = await db.select().from(deliveryQueue).where(eq(deliveryQueue.mind, mind));
  assert.equal(rows.length, 1);
  return rows[0];
}

/** The thread a row was stamped as peeked from; undefined when it was never stamped. */
function peekedThread(row: typeof deliveryQueue.$inferSelect): string | null | undefined {
  return row.peeked_at ? row.peeked_thread : undefined;
}

async function peek(mind: string, headers: Record<string, string>) {
  const { default: app } = await import("../packages/daemon/src/web/app.js");
  const res = await app.request(
    `http://localhost/api/v1/minds/${mind}/gates/peek?channel=${encodeURIComponent(CHANNEL)}`,
    { headers: { Origin: "http://localhost", ...headers } },
  );
  assert.equal(res.status, 200, await res.clone().text());
  return res;
}

describe("GET /minds/:name/gates/peek notes who looked (#1172)", () => {
  before(async () => {
    await cleanup();
    if (!tryGetDeliveryManager()) initDeliveryManager();
    await getOrCreateMindUser(MIND);
    await addMind(MIND, 4761);
    await getOrCreateSystemUser();
    await addSpirit(SPIRIT, 4762, "claude", "/tmp/volute-peek-reader-spirit");
    invalidateMindUserCache(MIND);
    invalidateMindUserCache(SPIRIT);
  });

  after(cleanup);

  it("stamps the thread when the mind peeks from one", async () => {
    await hold(MIND);
    const res = await peek(MIND, {
      Authorization: `Bearer ${generateMindToken(MIND)}`,
      "X-Volute-Thread": "main",
    });
    const body = (await res.json()) as { messages: { content: string }[] };
    assert.equal(body.messages[0].content, "hello?");
    assert.equal(peekedThread(await heldRow(MIND)), "main");
  });

  it("does not stamp when an admin peeks", async () => {
    await hold(MIND);
    const admin = await createUser(ADMIN, "pass");
    const cookie = await createSession(admin.id);
    await peek(MIND, { Cookie: `volute_session=${cookie}`, "X-Volute-Thread": "main" });
    assert.equal(peekedThread(await heldRow(MIND)), undefined);
  });

  it("does not stamp a script's peek, even naming a thread", async () => {
    await hold(MIND);
    await peek(MIND, {
      Authorization: `Bearer ${issueScriptToken(MIND)}`,
      "X-Volute-Thread": "main",
    });
    assert.equal(
      peekedThread(await heldRow(MIND)),
      undefined,
      "its output may never reach the mind",
    );
  });

  it("does not stamp a peek from no thread", async () => {
    await hold(MIND);
    await peek(MIND, { Authorization: `Bearer ${generateMindToken(MIND)}` });
    assert.equal(
      peekedThread(await heldRow(MIND)),
      undefined,
      "its output may never reach the mind",
    );
  });

  it("stamps the spirit's own peek — the mind strangers most often reach", async () => {
    await hold(SPIRIT);
    await peek(SPIRIT, {
      Authorization: `Bearer ${generateMindToken(SPIRIT)}`,
      "X-Volute-Thread": "main",
    });
    assert.equal(peekedThread(await heldRow(SPIRIT)), "main");
  });
});
