import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { getOrCreateMindUser, getOrCreateSystemUser } from "../packages/daemon/src/lib/auth.js";
import {
  _resetSpiritAvailabilityState,
  classifySpiritState,
  ensureSpiritAvailable,
  SPIRIT_NOTICE_PREFIX,
  spiritUnavailableNotice,
} from "../packages/daemon/src/lib/chat/spirit-availability.js";
import {
  configPath,
  readGlobalConfig,
  writeGlobalConfig,
} from "../packages/daemon/src/lib/config/setup.js";
import {
  initMindManager,
  tryGetMindManager,
} from "../packages/daemon/src/lib/daemon/mind-manager.js";
import {
  generateMindToken,
  revokeMindToken,
} from "../packages/daemon/src/lib/daemon/mind-tokens.js";
import {
  getSleepManagerIfReady,
  initSleepManager,
} from "../packages/daemon/src/lib/daemon/sleep-manager.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { createConversation } from "../packages/daemon/src/lib/events/conversations.js";
import { addMind, addSpirit, voluteSystemDir } from "../packages/daemon/src/lib/mind/registry.js";
import { _setSpiritCreationInProgressForTest } from "../packages/daemon/src/lib/mind/spirit.js";
import {
  conversations,
  messages,
  mindHistory,
  minds,
  users,
} from "../packages/daemon/src/lib/schema.js";
import { invalidateMindUserCache } from "../packages/daemon/src/web/middleware/auth.js";

// --- Daemon-boot window (MUST run before anything initializes the managers) ---

describe("ensureSpiritAvailable during the daemon-boot window", () => {
  it("returns null (indeterminate) before the mind/sleep managers initialize", async () => {
    // Guard: this test relies on running before any other test initializes the managers.
    assert.equal(tryGetMindManager(), null, "test ordering broken: mind manager already up");
    assert.equal(getSleepManagerIfReady(), null, "test ordering broken: sleep manager already up");
    const result = await ensureSpiritAvailable();
    assert.equal(result, null, "boot window must be indeterminate — no status, no notice");
  });
});

function ensureManagers() {
  if (!tryGetMindManager()) initMindManager();
  if (!getSleepManagerIfReady()) initSleepManager();
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

function clearCrashAttempts() {
  tryGetMindManager()?.clearCrashAttempts();
}

// --- Pure decision logic ---

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

  it("cannot-exist when stopped but recently failed to stay up (crash-loop honesty)", () => {
    assert.equal(
      classifySpiritState({
        setupComplete: true,
        spiritExists: true,
        sleeping: false,
        running: false,
        recentlyFailed: true,
      }),
      "cannot-exist",
    );
    // recentlyFailed never overrides an actually-up or sleeping spirit.
    assert.equal(
      classifySpiritState({
        setupComplete: true,
        spiritExists: true,
        sleeping: false,
        running: true,
        recentlyFailed: true,
      }),
      "running",
    );
    assert.equal(
      classifySpiritState({
        setupComplete: true,
        spiritExists: true,
        sleeping: true,
        running: false,
        recentlyFailed: true,
      }),
      "sleeping",
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
  it("both share the stable dedupe prefix", () => {
    assert.ok(spiritUnavailableNotice(false).startsWith(SPIRIT_NOTICE_PREFIX));
    assert.ok(spiritUnavailableNotice(true).startsWith(SPIRIT_NOTICE_PREFIX));
  });
});

// --- ensureSpiritAvailable (integration against real config/registry) ---

describe("ensureSpiritAvailable", () => {
  afterEach(async () => {
    _resetSpiritAvailabilityState();
    _setSpiritCreationInProgressForTest(false);
    clearCrashAttempts();
    await setSetupComplete(false);
    await removeSpirit();
  });

  it("reports unavailable with the setup-incomplete notice when setup is not done", async () => {
    ensureManagers();
    await setSetupComplete(false);
    const result = await ensureSpiritAvailable();
    assert.equal(result?.status, "unavailable");
    assert.match(result?.notice ?? "", /setup is incomplete/);
  });

  it("reports unavailable with the creation-failed notice when setup is done but no spirit exists", async () => {
    ensureManagers();
    await setSetupComplete(true);
    await removeSpirit();
    const result = await ensureSpiritAvailable();
    assert.equal(result?.status, "unavailable");
    assert.match(result?.notice ?? "", /failed to start/);
  });

  it("returns null (indeterminate) when the config file is unparseable — never a confident notice", async () => {
    ensureManagers();
    writeFileSync(configPath(), "{ this is not json");
    try {
      const result = await ensureSpiritAvailable();
      assert.equal(result, null, "a torn/corrupt config read must not classify anything");
    } finally {
      await setSetupComplete(false); // rewrites a valid config
    }
  });

  it("returns null while the spirit project is still being created", async () => {
    ensureManagers();
    await setSetupComplete(true);
    await removeSpirit();
    _setSpiritCreationInProgressForTest(true);
    try {
      const result = await ensureSpiritAvailable();
      assert.equal(result, null, "creation in flight must not read as creation failed");
    } finally {
      _setSpiritCreationInProgressForTest(false);
    }
  });

  it("reports unavailable (failed to start) without restarting when crash recovery is exhausted", async () => {
    ensureManagers();
    await setSetupComplete(true);
    await addSpirit("volute", 4098, "claude", "/tmp/volute-spirit-availability-test");
    // Simulate the tracker's give-up state (5 recorded crashes = default max).
    writeFileSync(resolve(voluteSystemDir(), "crash-attempts.json"), '{"volute": 5}\n');
    tryGetMindManager()?.loadCrashAttempts();

    const result = await ensureSpiritAvailable();
    assert.equal(result?.status, "unavailable");
    assert.match(
      result?.notice ?? "",
      /failed to start/,
      "a crash-looping spirit must be reported honestly, not 'waking' forever",
    );
  });
});

// --- Route-level: honest notice + status surfacing via POST /api/v1/chat ---

const SENDER_MIND = "spirit-avail-sender";
const NOTICE_RE = /system spirit isn't available/;
const DAEMON_TOKEN = "spirit-avail-test-token";

let routeConvId: string | undefined;

async function routeCleanup() {
  process.env.VOLUTE_DAEMON_TOKEN = DAEMON_TOKEN;
  _resetSpiritAvailabilityState();
  _setSpiritCreationInProgressForTest(false);
  clearCrashAttempts();
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

/** DM whose sole mind-ish participant is the system user (the human ↔ spirit shape). */
async function setupHumanSpiritDM(): Promise<string> {
  ensureManagers();
  const systemUser = await getOrCreateSystemUser();
  const conv = await createConversation({ participantIds: [systemUser.id] });
  routeConvId = conv.id;
  return conv.id;
}

/** DM between a registered sender mind and the system user (spirit). */
async function setupMindSpiritDM(): Promise<{ conversationId: string; mindToken: string }> {
  ensureManagers();
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
    const conversationId = await setupHumanSpiritDM();
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    // Daemon token + non-mind sender = human-style sender.
    const res = await chatSend(app as never, DAEMON_TOKEN, {
      conversationId,
      message: "hello volute",
      sender: "some-human",
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { spirit?: string; spiritName?: string };
    assert.equal(data.spirit, "unavailable");
    assert.equal(data.spiritName, "volute");

    const notices = await spiritMessages(conversationId);
    assert.equal(notices.length, 1, "exactly one honest notice should be persisted");
    assert.equal(notices[0].role, "assistant");
    assert.match(notices[0].content, NOTICE_RE);

    // Send again — the notice must not stack.
    const res2 = await chatSend(app as never, DAEMON_TOKEN, {
      conversationId,
      message: "anyone there?",
      sender: "some-human",
    });
    assert.equal(res2.status, 200);
    const notices2 = await spiritMessages(conversationId);
    assert.equal(notices2.length, 1, "repeat sends must not add duplicate notices");
  });

  it("concurrent sends persist at most one notice (read-then-write race closed)", async () => {
    await routeCleanup();
    const conversationId = await setupHumanSpiritDM();
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const [r1, r2] = await Promise.all([
      chatSend(app as never, DAEMON_TOKEN, {
        conversationId,
        message: "first",
        sender: "some-human",
      }),
      chatSend(app as never, DAEMON_TOKEN, {
        conversationId,
        message: "second",
        sender: "some-human",
      }),
    ]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    const notices = await spiritMessages(conversationId);
    assert.equal(notices.length, 1, "concurrent sends must not double-persist the notice");
  });

  it("mind sender gets the status in the response and the same persisted notice", async () => {
    await routeCleanup();
    const { conversationId, mindToken } = await setupMindSpiritDM();
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

  it("channels never get a spirit status or notice — availability surfacing is DM-only", async () => {
    await routeCleanup();
    ensureManagers();
    const systemUser = await getOrCreateSystemUser();
    const mindUser = await getOrCreateMindUser(SENDER_MIND);
    await addMind(SENDER_MIND, 4181);
    invalidateMindUserCache(SENDER_MIND);
    const token = generateMindToken(SENDER_MIND);
    const conv = await createConversation({
      type: "channel",
      participantIds: [mindUser.id, systemUser.id],
    });
    routeConvId = conv.id;
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await chatSend(app as never, token, {
      conversationId: conv.id,
      message: "hello #channel",
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { spirit?: string };
    assert.equal(data.spirit, undefined, "channel sends must not block on or report spirit state");
    assert.equal((await spiritMessages(conv.id)).length, 0, "no notice in channels");
  });

  it("no spirit status or notice when the conversation has no system participant", async () => {
    await routeCleanup();
    ensureManagers();
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
      "spirit status only applies when the spirit is the sole recipient",
    );
    assert.equal((await spiritMessages(conv.id)).length, 0);
  });

  it("a broken config read degrades to no status and no notice — delivery still succeeds", async () => {
    await routeCleanup();
    const conversationId = await setupHumanSpiritDM();
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    writeFileSync(configPath(), "{ torn write !!");
    try {
      const res = await chatSend(app as never, DAEMON_TOKEN, {
        conversationId,
        message: "hello?",
        sender: "some-human",
      });
      assert.equal(res.status, 200, "availability problems must never fail the send");
      const data = (await res.json()) as { spirit?: string };
      assert.equal(data.spirit, undefined, "no confident status from an unconfident read");
      assert.equal((await spiritMessages(conversationId)).length, 0, "no false notice");

      // The sender's message itself was persisted and delivery proceeded.
      const db = await getDb();
      const all = await db
        .select()
        .from(messages)
        .where(eq(messages.conversation_id, conversationId))
        .all();
      assert.equal(all.length, 1, "the sender's message must persist despite the broken read");
    } finally {
      await setSetupComplete(false); // rewrites a valid config
    }
  });
});
