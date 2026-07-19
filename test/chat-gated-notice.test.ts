import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq, inArray } from "drizzle-orm";
import { getOrCreateMindUser } from "../packages/daemon/src/lib/auth.js";
import {
  initMindManager,
  tryGetMindManager,
} from "../packages/daemon/src/lib/daemon/mind-manager.js";
import {
  generateMindToken,
  revokeMindToken,
} from "../packages/daemon/src/lib/daemon/mind-tokens.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  initDeliveryManager,
  tryGetDeliveryManager,
} from "../packages/daemon/src/lib/delivery/delivery-manager.js";
import { createConversation } from "../packages/daemon/src/lib/events/conversations.js";
import { addMind } from "../packages/daemon/src/lib/mind/registry.js";
import {
  conversations,
  deliveryQueue,
  messages,
  mindHistory,
  minds,
  systemEvents,
  users,
} from "../packages/daemon/src/lib/schema.js";
import { invalidateMindUserCache } from "../packages/daemon/src/web/middleware/auth.js";

const SENDER = "gated-notice-sender";
const RECIPIENT = "gated-notice-recipient";
const TEST_USERNAMES = [SENDER, RECIPIENT];

let convId: string | undefined;

/** The manager's private map of running minds — the thing `isRunning` reads. */
function tracked(): Map<string, { child: ChildProcess; port: number }> | undefined {
  const manager = tryGetMindManager();
  if (!manager) return undefined;
  return (manager as unknown as { minds: Map<string, { child: ChildProcess; port: number }> })
    .minds;
}

async function cleanup() {
  for (const name of TEST_USERNAMES) revokeMindToken(name);
  const db = await getDb();
  if (convId) {
    await db.delete(messages).where(eq(messages.conversation_id, convId));
    await db.delete(conversations).where(eq(conversations.id, convId));
    convId = undefined;
  }
  await db.delete(mindHistory).where(inArray(mindHistory.mind, TEST_USERNAMES));
  await db.delete(systemEvents).where(inArray(systemEvents.mind, TEST_USERNAMES));
  await db.delete(deliveryQueue).where(inArray(deliveryQueue.mind, TEST_USERNAMES));
  await db.delete(users).where(inArray(users.username, TEST_USERNAMES));
  await db.delete(minds).where(inArray(minds.name, TEST_USERNAMES));
  for (const name of TEST_USERNAMES) tracked()?.delete(name);
}

/**
 * A mind sender, a running recipient mind with NO routes.json (so every channel is
 * unmatched and gating — the default — holds the message), and a DM between them.
 */
async function setup(): Promise<{ token: string; conversationId: string }> {
  if (!tryGetMindManager()) initMindManager();
  if (!tryGetDeliveryManager()) initDeliveryManager();

  const senderUser = await getOrCreateMindUser(SENDER);
  const recipientUser = await getOrCreateMindUser(RECIPIENT);
  await addMind(SENDER, 4731);
  const recipientEntry = await addMind(RECIPIENT, 4732);
  tracked()!.set(RECIPIENT, {
    child: {} as ChildProcess,
    port: recipientEntry?.port ?? 4732,
  });

  invalidateMindUserCache(SENDER);
  const conv = await createConversation({ participantIds: [senderUser.id, recipientUser.id] });
  convId = conv.id;
  return { token: generateMindToken(SENDER), conversationId: conv.id };
}

function send(app: { request: typeof fetch }, token: string, body: unknown) {
  return app.request("http://localhost/api/v1/chat", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: "http://localhost",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  } as RequestInit);
}

describe("POST /api/v1/chat gated-recipient notice (#723)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("includes a notice in the 200 when the recipient's routing gates the channel", async () => {
    const { token, conversationId } = await setup();
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await send(app as never, token, { conversationId, message: "are you there?" });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { ok: boolean; notice?: string };
    assert.equal(data.ok, true);
    assert.ok(data.notice, "the 200 must carry a notice when the message will be held");
    assert.ok(
      data.notice!.includes(RECIPIENT),
      `notice should name the gated recipient: ${data.notice}`,
    );
    assert.match(data.notice!, /held/);
  });

  it("omits the notice when the recipient routes the channel", async () => {
    const { token, conversationId } = await setup();

    // Give the recipient a routes.json that matches everything — nothing gates.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { mindDir } = await import("../packages/daemon/src/lib/mind/registry.js");
    const cfgDir = resolve(mindDir(RECIPIENT), "home/.config");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      resolve(cfgDir, "routes.json"),
      JSON.stringify({ rules: [{ channel: "*", thread: "main" }] }),
    );

    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await send(app as never, token, { conversationId, message: "routed fine" });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { ok: boolean; notice?: string };
    assert.equal(data.ok, true);
    assert.equal(data.notice, undefined, "a routed channel must not produce a hold notice");
  });
});

describe("file-sharing responses carry `notified` (#723)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("stage reports notified honestly and accept reports notified:false for a non-mind sender", async () => {
    await setup();
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    // A tiny mind stand-in on the recipient's port that acks the event envelope,
    // so the first stage exercises the notified:true (actually delivered) path.
    const { createServer } = await import("node:http");
    const { findMind } = await import("../packages/daemon/src/lib/mind/registry.js");
    const recipientPort = (await findMind(RECIPIENT))!.port;
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ event: true }));
    });
    await new Promise<void>((resolve) => server.listen(recipientPort, "127.0.0.1", resolve));

    invalidateMindUserCache(RECIPIENT);
    const recipientToken = generateMindToken(RECIPIENT);
    const stage = (filename: string) =>
      app.request(`http://localhost/api/minds/${RECIPIENT}/files/stage`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${recipientToken}`,
          Origin: "http://localhost",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sender: "some-human",
          filename,
          data: Buffer.from("hello").toString("base64"),
        }),
      } as RequestInit);

    let staged: { id: string; notified?: boolean };
    try {
      const stageRes = await stage("notes.txt");
      assert.equal(stageRes.status, 200);
      staged = (await stageRes.json()) as { id: string; notified?: boolean };
      assert.equal(staged.notified, true, "the recipient ack'd the event — notified");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // With the recipient awake but unreachable, the pending event only replays on the
    // next wake/restart — the honest answer is notified:false (#723).
    const stageRes2 = await stage("notes2.txt");
    assert.equal(stageRes2.status, 200);
    const staged2 = (await stageRes2.json()) as { id: string; notified?: boolean };
    assert.equal(
      staged2.notified,
      false,
      "an awake but unreachable recipient must not be reported as notified",
    );

    // Accepting notifies the sender — a human with no mind entry, so notified must be false.
    const acceptRes = await app.request(`http://localhost/api/minds/${RECIPIENT}/files/accept`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${recipientToken}`,
        Origin: "http://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: staged.id }),
    } as RequestInit);
    assert.equal(acceptRes.status, 200);
    const accepted = (await acceptRes.json()) as { ok: boolean; notified?: boolean };
    assert.equal(accepted.ok, true);
    assert.equal(
      accepted.notified,
      false,
      "the sender is not a mind — the response must say they were not notified",
    );
  });
});
