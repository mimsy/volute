import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { getOrCreateMindUser, getOrCreateSystemUser } from "../packages/daemon/src/lib/auth.js";
import {
  classifySpiritState,
  ensureSpiritAvailable,
  spiritUnavailableNotice,
} from "../packages/daemon/src/lib/chat/spirit-availability.js";
import { readGlobalConfig, writeGlobalConfig } from "../packages/daemon/src/lib/config/setup.js";
import {
  initMindManager,
  tryGetMindManager,
} from "../packages/daemon/src/lib/daemon/mind-manager.js";
import {
  generateMindToken,
  revokeMindToken,
} from "../packages/daemon/src/lib/daemon/mind-tokens.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { createConversation } from "../packages/daemon/src/lib/events/conversations.js";
import { addMind } from "../packages/daemon/src/lib/mind/registry.js";
import {
  conversations,
  messages,
  mindHistory,
  minds,
  users,
} from "../packages/daemon/src/lib/schema.js";
import { invalidateMindUserCache } from "../packages/daemon/src/web/middleware/auth.js";

function ensureManager() {
  if (!tryGetMindManager()) initMindManager();
}

async function setSetupComplete(complete: boolean) {
  const config = readGlobalConfig();
  if (complete) {
    config.setup = { ...(config.setup ?? {}) } as typeof config.setup;
    config.setupCompleted = true;
  } else {
    delete config.setup;
    delete config.setupCompleted;
  }
  writeGlobalConfig(config);
}

async function removeSpirit() {
  const db = await getDb();
  await db.delete(minds).where(eq(minds.name, "volute"));
}

describe("classifySpiritState (pure decision logic)", () => {
  it("cannot-exist when setup is incomplete, regardless of process state", () => {
    assert.equal(
      classifySpiritState({
        setupComplete: false,
        spiritExists: true,
        sleeping: false,
        running: true,
      }),
      "cannot-exist",
    );
    assert.equal(
      classifySpiritState({
        setupComplete: false,
        spiritExists: false,
        sleeping: false,
        running: false,
      }),
      "cannot-exist",
    );
  });

  it("cannot-exist when setup is complete but the spirit isn't registered", () => {
    assert.equal(
      classifySpiritState({
        setupComplete: true,
        spiritExists: false,
        sleeping: false,
        running: false,
      }),
      "cannot-exist",
    );
  });

  it("sleeping wins over running (queue delivers on wake — don't force-wake)", () => {
    assert.equal(
      classifySpiritState({
        setupComplete: true,
        spiritExists: true,
        sleeping: true,
        running: false,
      }),
      "sleeping",
    );
    // A sleeping mind's process may still register as running mid-transition; sleeping wins.
    assert.equal(
      classifySpiritState({
        setupComplete: true,
        spiritExists: true,
        sleeping: true,
        running: true,
      }),
      "sleeping",
    );
  });

  it("running when up and not sleeping", () => {
    assert.equal(
      classifySpiritState({
        setupComplete: true,
        spiritExists: true,
        sleeping: false,
        running: true,
      }),
      "running",
    );
  });

  it("stopped when it exists, is awake, but the process is down (the on-demand-start case)", () => {
    assert.equal(
      classifySpiritState({
        setupComplete: true,
        spiritExists: true,
        sleeping: false,
        running: false,
      }),
      "stopped",
    );
  });
});

describe("spiritUnavailableNotice", () => {
  it("blames setup when setup is incomplete", () => {
    assert.match(spiritUnavailableNotice(false), /setup is incomplete/);
    assert.match(spiritUnavailableNotice(false), /Settings/);
  });
  it("blames a failed start when setup is complete", () => {
    assert.match(spiritUnavailableNotice(true), /failed to start/);
  });
});

describe("ensureSpiritAvailable", () => {
  afterEach(async () => {
    await setSetupComplete(false);
    await removeSpirit();
  });

  it("reports unavailable with the setup-incomplete notice when setup is not done", async () => {
    ensureManager();
    await setSetupComplete(false);
    const result = await ensureSpiritAvailable();
    assert.equal(result.status, "unavailable");
    assert.match(result.notice ?? "", /setup is incomplete/);
  });

  it("reports unavailable with the creation-failed notice when setup is done but no spirit exists", async () => {
    ensureManager();
    await setSetupComplete(true);
    await removeSpirit();
    const result = await ensureSpiritAvailable();
    assert.equal(result.status, "unavailable");
    assert.match(result.notice ?? "", /failed to start/);
  });
});

// --- Route-level: honest notice + status surfacing via POST /api/v1/chat ---

const SENDER_MIND = "spirit-avail-sender";
const NOTICE_RE = /system spirit isn't available/;

let routeConvId: string | undefined;

async function routeCleanup() {
  process.env.VOLUTE_DAEMON_TOKEN = "spirit-avail-test-token";
  revokeMindToken(SENDER_MIND);
  invalidateMindUserCache(SENDER_MIND);
  invalidateMindUserCache("volute");
  await setSetupComplete(false);
  const db = await getDb();
  if (routeConvId) {
    await db.delete(messages).where(eq(messages.conversation_id, routeConvId));
    await db.delete(conversations).where(eq(conversations.id, routeConvId));
    routeConvId = undefined;
  }
  await db.delete(mindHistory).where(eq(mindHistory.mind, SENDER_MIND));
  await db.delete(users).where(eq(users.username, "volute"));
  await db.delete(users).where(eq(users.username, SENDER_MIND));
  await db.delete(minds).where(eq(minds.name, "volute"));
  await db.delete(minds).where(eq(minds.name, SENDER_MIND));
}

/** DM between the system user (spirit) and a registered sender mind. */
async function setupConversation(): Promise<{ conversationId: string; mindToken: string }> {
  ensureManager();
  const systemUser = await getOrCreateSystemUser();
  const mindUser = await getOrCreateMindUser(SENDER_MIND);
  await addMind(SENDER_MIND, 4181);
  invalidateMindUserCache(SENDER_MIND);
  const conv = await createConversation({ participantIds: [mindUser.id, systemUser.id] });
  routeConvId = conv.id;
  return { conversationId: conv.id, mindToken: generateMindToken(SENDER_MIND) };
}

function chatSend(app: { request: typeof fetch }, token: string, body: unknown) {
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

async function spiritMessages(conversationId: string) {
  const db = await getDb();
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversation_id, conversationId))
    .all();
  return msgs.filter((m) => m.sender_name === "volute");
}

describe("POST /api/v1/chat spirit availability", () => {
  afterEach(routeCleanup);

  it("human DM to a spirit that cannot exist gets one honest persisted notice, not silence", async () => {
    await routeCleanup();
    const { conversationId } = await setupConversation();
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    // Daemon token + non-mind sender = human-style sender.
    const res = await chatSend(app as never, "spirit-avail-test-token", {
      conversationId,
      message: "hello volute",
      sender: "some-human",
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { spirit?: string };
    assert.equal(data.spirit, "unavailable");

    const notices = await spiritMessages(conversationId);
    assert.equal(notices.length, 1, "exactly one honest notice should be persisted");
    assert.equal(notices[0].role, "assistant");
    assert.match(notices[0].content, NOTICE_RE);

    // Send again — the notice must not stack.
    const res2 = await chatSend(app as never, "spirit-avail-test-token", {
      conversationId,
      message: "anyone there?",
      sender: "some-human",
    });
    assert.equal(res2.status, 200);
    const notices2 = await spiritMessages(conversationId);
    assert.equal(notices2.length, 1, "repeat sends must not add duplicate notices");
  });

  it("mind sender gets the status in the response and the same persisted notice", async () => {
    await routeCleanup();
    const { conversationId, mindToken } = await setupConversation();
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await chatSend(app as never, mindToken, {
      conversationId,
      message: "hello from a mind",
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { spirit?: string };
    assert.equal(data.spirit, "unavailable");

    const notices = await spiritMessages(conversationId);
    assert.equal(notices.length, 1, "the honest notice should be persisted for mind senders too");
    assert.match(notices[0].content, NOTICE_RE);
  });

  it("no spirit status or notice when the conversation has no system participant", async () => {
    await routeCleanup();
    ensureManager();
    const mindUser = await getOrCreateMindUser(SENDER_MIND);
    await addMind(SENDER_MIND, 4181);
    invalidateMindUserCache(SENDER_MIND);
    const token = generateMindToken(SENDER_MIND);
    const conv = await createConversation({ participantIds: [mindUser.id] });
    routeConvId = conv.id;
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await chatSend(app as never, token, {
      conversationId: conv.id,
      message: "just a mind talking",
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { spirit?: string };
    assert.equal(
      data.spirit,
      undefined,
      "spirit status only applies when the spirit is a recipient",
    );
    assert.equal((await spiritMessages(conv.id)).length, 0);
  });
});
