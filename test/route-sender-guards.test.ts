import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { createUser, getOrCreateMindUser } from "../packages/daemon/src/lib/auth.js";
import { getTypingMap } from "../packages/daemon/src/lib/chat/typing.js";
import {
  generateMindToken,
  revokeMindToken,
} from "../packages/daemon/src/lib/daemon/mind-tokens.js";
import { clearMind } from "../packages/daemon/src/lib/daemon/turn-tracker.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { addMind, addVariant } from "../packages/daemon/src/lib/mind/registry.js";
import { mindHistory, minds, users } from "../packages/daemon/src/lib/schema.js";
import {
  createSession,
  invalidateMindUserCache,
} from "../packages/daemon/src/web/middleware/auth.js";

const MIND = "sg-atlas";
const OTHER = "sg-lyra";
const HOST = "sg-host";
const VARIANT = "sg-atlas-v1";
const CHANNEL = "sg-conv-1";

type Fixture = {
  app: { request: typeof fetch };
  mindToken: string;
  hostSession: string;
};

async function setup(): Promise<Fixture> {
  await addMind(MIND, 14420);
  await addMind(OTHER, 14421);
  await getOrCreateMindUser(MIND);
  await getOrCreateMindUser(OTHER);
  const host = await createUser(HOST, "pw");
  const db = await getDb();
  await db.update(users).set({ role: "admin" }).where(eq(users.id, host.id));
  invalidateMindUserCache(MIND);
  invalidateMindUserCache(OTHER);

  const { default: app } = await import("../packages/daemon/src/web/app.js");
  return {
    app: app as never,
    mindToken: generateMindToken(MIND),
    hostSession: await createSession(host.id),
  };
}

async function cleanup() {
  for (const m of [MIND, OTHER, VARIANT]) {
    revokeMindToken(m);
    await clearMind(m);
    getTypingMap().deleteSender(m);
  }
  getTypingMap().deleteSender(HOST);
  const db = await getDb();
  for (const m of [MIND, OTHER, VARIANT]) {
    await db.delete(mindHistory).where(eq(mindHistory.mind, m));
    await db.delete(minds).where(eq(minds.name, m));
  }
  for (const u of [MIND, OTHER, VARIANT, HOST]) {
    await db.delete(users).where(eq(users.username, u));
  }
}

function post(f: Fixture, token: string, path: string, body: unknown) {
  return f.app.request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: "http://localhost",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  } as RequestInit);
}

async function historyRows(mind: string) {
  const db = await getDb();
  return db.select().from(mindHistory).where(eq(mindHistory.mind, mind)).all();
}

/**
 * Two routes took a caller-supplied `sender` and rendered it as an identity — one
 * persisted into `volute mind history`, one broadcast live as "X is typing" (#992).
 * Both are the #500 shape that `/api/v1/chat`, `channels/create` and `files/stage`
 * already close: the name shown is the authenticated principal's, and asking for
 * another is refused rather than quietly rewritten.
 */
describe("caller-supplied sender on history and typing", { concurrency: 1 }, () => {
  afterEach(cleanup);

  // --- POST /:name/history ---

  it("refuses a mind writing its own history under another mind's name", async () => {
    const f = await setup();
    const res = await post(f, f.mindToken, `/api/v1/minds/${MIND}/history`, {
      channel: "discord:server/general",
      content: "not in my name",
      sender: OTHER,
    });
    assert.equal(res.status, 403, `expected 403, got ${res.status}: ${await res.text()}`);

    const rows = await historyRows(MIND);
    assert.equal(rows.length, 0, "a refused write must leave nothing behind");
  });

  it("tells the caller nothing was recorded and who they actually are", async () => {
    const f = await setup();
    const res = await post(f, f.mindToken, `/api/v1/minds/${MIND}/history`, {
      channel: "discord:server/general",
      content: "x",
      sender: OTHER,
    });
    const { error } = (await res.json()) as { error: string };
    assert.match(error, /Refused to send as/, error);
    assert.match(error, new RegExp(`authenticated as "${MIND}"`), error);
  });

  it("records the authenticated mind when no sender is given", async () => {
    const f = await setup();
    const res = await post(f, f.mindToken, `/api/v1/minds/${MIND}/history`, {
      channel: "discord:server/general",
      content: "said out loud",
    });
    assert.equal(res.status, 200, await res.text());

    const rows = await historyRows(MIND);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sender, MIND, "attributed to the mind itself");
  });

  it("still accepts a mind naming itself", async () => {
    const f = await setup();
    const res = await post(f, f.mindToken, `/api/v1/minds/${MIND}/history`, {
      channel: "discord:server/general",
      content: "my own name",
      sender: MIND,
    });
    assert.equal(res.status, 200, `a mind's own name is not impersonation: ${await res.text()}`);
    assert.equal((await historyRows(MIND))[0]?.sender, MIND);
  });

  // requireSelf() base-maps a variant's token to its parent so a variant can report
  // its own events (#652), and its history is recorded under the parent. A guard that
  // compared the literal caller name would 403 a variant naming itself.
  it("accepts a variant naming itself, and records it under the parent", async () => {
    const f = await setup();
    await addVariant(VARIANT, MIND, 14422, "/tmp/volute-sg-variant", "variant/sg-atlas-v1");
    await getOrCreateMindUser(VARIANT);
    invalidateMindUserCache(VARIANT);

    const res = await post(f, generateMindToken(VARIANT), `/api/v1/minds/${VARIANT}/history`, {
      channel: "discord:server/general",
      content: "said by the variant",
      sender: VARIANT,
    });
    assert.equal(res.status, 200, `a variant's own name must not be refused: ${await res.text()}`);

    const rows = await historyRows(MIND);
    assert.equal(rows.length, 1, "recorded under the parent, as history always is");
    assert.equal(rows[0].sender, MIND);
  });

  // requireSelf() also admits an admin, whose username is not the mind's. The row is
  // the mind's outbound speech either way, so the mind's name is what may be asked
  // for — refusing the admin's own name here is the point, not a gap.
  it("refuses an admin recording an outbound row under their own name", async () => {
    const f = await setup();
    const res = await post(f, f.hostSession, `/api/v1/minds/${MIND}/history`, {
      channel: "discord:server/general",
      content: "spoken by the host",
      sender: HOST,
    });
    assert.equal(res.status, 403, `expected 403, got ${res.status}: ${await res.text()}`);
    assert.equal((await historyRows(MIND)).length, 0);
  });

  // --- POST /:name/typing ---

  it("refuses a host broadcasting a mind as the one typing", async () => {
    const f = await setup();
    const res = await post(f, f.hostSession, `/api/v1/minds/${MIND}/typing`, {
      channel: CHANNEL,
      sender: MIND,
      active: true,
    });
    assert.equal(res.status, 403, `expected 403, got ${res.status}: ${await res.text()}`);
    assert.deepEqual(getTypingMap().get(CHANNEL), [], "a refused report must broadcast nothing");
  });

  it("broadcasts the authenticated user when no sender is given", async () => {
    const f = await setup();
    const res = await post(f, f.hostSession, `/api/v1/minds/${MIND}/typing`, {
      channel: CHANNEL,
      active: true,
    });
    assert.equal(res.status, 200, await res.text());
    assert.deepEqual(getTypingMap().get(CHANNEL), [HOST]);
  });

  // The web composer sends its own username on every keystroke burst — the path that
  // must not break.
  it("still accepts a caller naming themselves, and clears the same entry", async () => {
    const f = await setup();
    const on = await post(f, f.hostSession, `/api/v1/minds/${MIND}/typing`, {
      channel: CHANNEL,
      sender: HOST,
      active: true,
    });
    assert.equal(on.status, 200, `own name is not impersonation: ${await on.text()}`);
    assert.deepEqual(getTypingMap().get(CHANNEL), [HOST]);

    const off = await post(f, f.hostSession, `/api/v1/minds/${MIND}/typing`, {
      channel: CHANNEL,
      sender: HOST,
      active: false,
    });
    assert.equal(off.status, 200);
    assert.deepEqual(getTypingMap().get(CHANNEL), []);
  });
});
