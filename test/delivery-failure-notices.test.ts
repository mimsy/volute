import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq, inArray } from "drizzle-orm";
import type { RecordNoticeInput } from "../packages/daemon/src/lib/chat/system-events.js";
import {
  initMindManager,
  tryGetMindManager,
} from "../packages/daemon/src/lib/daemon/mind-manager.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  FAILURE_NOTICE_WINDOW_MS,
  reportSendFailure,
  resetSendFailureState,
  setSendFailureClock,
  setSendFailureNotifier,
} from "../packages/daemon/src/lib/delivery/delivery-failures.js";
import { fanOutToMinds } from "../packages/daemon/src/lib/delivery/fan-out.js";
import { addMind, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import { minds } from "../packages/daemon/src/lib/schema.js";
import log from "../packages/daemon/src/lib/util/logger.js";

const SENDER = "dfn-sender";
const RECIPIENT = "dfn-recipient";
const STOPPED = "dfn-stopped";
const EXTERNAL = "dfn-external";
const HUMAN = "dfn-human";

const MIND_NAMES = [SENDER, RECIPIENT, STOPPED];
const CONVERSATION_ID = "dfn-conversation";

type Participant = Parameters<typeof fanOutToMinds>[0]["participants"];

/** The manager's private map of running minds — the thing `isRunning` reads. */
function tracked(): Map<string, { child: ChildProcess; port: number }> | undefined {
  const manager = tryGetMindManager();
  if (!manager) return undefined;
  return (manager as unknown as { minds: Map<string, { child: ChildProcess; port: number }> })
    .minds;
}

/** Mark a mind as running without spawning a real process. */
function markRunning(name: string, port: number) {
  const map = tracked();
  assert.ok(map, "mind manager must be initialized");
  map.set(name, { child: {} as ChildProcess, port });
}

function participant(username: string, userType: string, userId: number) {
  return { userId, username, userType, role: "member" };
}

async function cleanup() {
  resetSendFailureState();
  setSendFailureNotifier();
  setSendFailureClock();
  const db = await getDb();
  await db.delete(minds).where(inArray(minds.name, MIND_NAMES));
  for (const name of MIND_NAMES) tracked()?.delete(name);
}

/** Poll until the predicate holds or the timeout elapses. */
async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

describe("send-failure notice coalescing", () => {
  let notices: RecordNoticeInput[];
  let now: number;

  beforeEach(() => {
    resetSendFailureState();
    notices = [];
    now = 1_700_000_000_000;
    setSendFailureNotifier(async (input) => {
      notices.push(input);
    });
    setSendFailureClock(() => now);
  });

  afterEach(() => {
    resetSendFailureState();
    setSendFailureNotifier();
    setSendFailureClock();
  });

  it("notices the first failure immediately", async () => {
    await reportSendFailure({
      senderMind: SENDER,
      channel: `@${RECIPIENT}`,
      recipient: RECIPIENT,
      reason: "delivery failed",
    });
    assert.equal(notices.length, 1);
    assert.equal(notices[0].mind, SENDER);
    assert.equal(notices[0].kind, "delivery_failed");
    assert.ok(notices[0].detail.includes(`@${RECIPIENT}`), notices[0].detail);
    assert.ok(notices[0].detail.includes(RECIPIENT), notices[0].detail);
  });

  it("coalesces repeated failures for the same (mind, channel) within the window", async () => {
    for (let i = 0; i < 5; i++) {
      now += 60_000;
      await reportSendFailure({
        senderMind: SENDER,
        channel: `@${RECIPIENT}`,
        recipient: RECIPIENT,
        reason: "delivery failed",
      });
    }
    assert.equal(notices.length, 1, "burst within the window must produce exactly one notice");
  });

  it("rolls up accumulated failures into one notice after the window", async () => {
    // First failure → immediate notice.
    await reportSendFailure({
      senderMind: SENDER,
      channel: `@${RECIPIENT}`,
      recipient: RECIPIENT,
      reason: "delivery failed",
    });
    // Three more inside the window → silent accumulation.
    for (let i = 0; i < 3; i++) {
      now += 60_000;
      await reportSendFailure({
        senderMind: SENDER,
        channel: `@${RECIPIENT}`,
        recipient: RECIPIENT,
        reason: "delivery failed",
      });
    }
    assert.equal(notices.length, 1);
    // A failure past the window emits ONE rollup covering everything since the last notice.
    now += FAILURE_NOTICE_WINDOW_MS;
    await reportSendFailure({
      senderMind: SENDER,
      channel: `@${RECIPIENT}`,
      recipient: RECIPIENT,
      reason: "delivery failed",
    });
    assert.equal(notices.length, 2);
    assert.match(notices[1].detail, /4 messages on @dfn-recipient have failed/);
  });

  it("tracks distinct channels independently", async () => {
    await reportSendFailure({
      senderMind: SENDER,
      channel: "#general",
      recipient: RECIPIENT,
      reason: "delivery failed",
    });
    await reportSendFailure({
      senderMind: SENDER,
      channel: `@${RECIPIENT}`,
      recipient: RECIPIENT,
      reason: "delivery failed",
    });
    assert.equal(notices.length, 2, "different channels must not coalesce into one bucket");
  });
});

describe("fan-out surfaces lost deliveries to a mind sender", () => {
  let notices: RecordNoticeInput[];

  beforeEach(async () => {
    if (!tryGetMindManager()) initMindManager();
    await cleanup();
    notices = [];
    setSendFailureNotifier(async (input) => {
      notices.push(input);
    });
  });

  afterEach(cleanup);

  // The DeliveryManager is deliberately NOT initialized in this file: deliverMessage's
  // routeAndDeliver then throws before any delivery_queue row exists — exactly the
  // pre-queue failure class (#723) the redrive loop cannot recover.
  it("records a notice for the sender when deliverMessage fails pre-queue", async () => {
    await addMind(SENDER, 4721);
    const recipientEntry = await addMind(RECIPIENT, 4722);
    markRunning(RECIPIENT, recipientEntry?.port ?? 4722);

    const participants = [
      participant(SENDER, "mind", 1),
      participant(RECIPIENT, "mind", 2),
    ] as unknown as Participant;

    await fanOutToMinds({
      conversationId: CONVERSATION_ID,
      contentBlocks: [{ type: "text", text: "hello" }],
      senderName: SENDER,
      participants,
    });

    assert.ok(
      await waitFor(() => notices.length > 0),
      "a pre-queue delivery failure must record a sender notice",
    );
    assert.equal(notices[0].mind, SENDER);
    assert.equal(notices[0].kind, "delivery_failed");
    assert.ok(
      notices[0].detail.includes(`@${RECIPIENT}`),
      `notice should name the channel from the sender's perspective: ${notices[0].detail}`,
    );
  });

  it("records a notice for the sender when a registered recipient is not running", async () => {
    await addMind(SENDER, 4723);
    await addMind(STOPPED, 4724); // registered, never marked running

    const participants = [
      participant(SENDER, "mind", 1),
      participant(STOPPED, "mind", 2),
    ] as unknown as Participant;

    await fanOutToMinds({
      conversationId: CONVERSATION_ID,
      contentBlocks: [{ type: "text", text: "anyone home?" }],
      senderName: SENDER,
      participants,
    });

    assert.ok(
      await waitFor(() => notices.length > 0),
      "a skipped not-running recipient must record a sender notice",
    );
    assert.equal(notices[0].mind, SENDER);
    assert.match(notices[0].detail, /recipient not running/);
  });

  it("records no notice when the sender is not a registered mind", async () => {
    const recipientEntry = await addMind(RECIPIENT, 4725);
    markRunning(RECIPIENT, recipientEntry?.port ?? 4725);

    const participants = [
      participant(HUMAN, "human", 1),
      participant(RECIPIENT, "mind", 2),
    ] as unknown as Participant;

    await fanOutToMinds({
      conversationId: CONVERSATION_ID,
      contentBlocks: [{ type: "text", text: "hello" }],
      senderName: HUMAN,
      participants,
    });

    // Give the fire-and-forget delivery time to fail; no notice must appear.
    assert.equal(await waitFor(() => notices.length > 0, 500), false);
    assert.equal(notices.length, 0);
  });

  it("logs (info) the skip of a mind-typed participant with no registry row", async () => {
    const infos: string[] = [];
    const original = log.info;
    log.info = (msg: string, ...rest: unknown[]) => {
      infos.push(String(msg));
      return original.call(log, msg, ...rest);
    };
    try {
      const participants = [
        participant(HUMAN, "human", 1),
        participant(EXTERNAL, "mind", 2), // no minds row → external/stale
      ] as unknown as Participant;
      await fanOutToMinds({
        conversationId: CONVERSATION_ID,
        contentBlocks: [{ type: "text", text: "quiet" }],
        senderName: HUMAN,
        participants,
      });
    } finally {
      log.info = original;
    }
    assert.ok(
      infos.some((m) => m.includes(EXTERNAL) && m.includes("no registry row")),
      `external-mind skip must leave an info trace, got: ${JSON.stringify(infos)}`,
    );
  });

  it("reports gated recipients from the will-gate prediction", async () => {
    // No routes.json exists for the recipient → unmatched channel with gating on (the
    // default), so fan-out must predict the hold and name the recipient.
    await addMind(SENDER, 4726);
    const recipientEntry = await addMind(RECIPIENT, 4727);
    markRunning(RECIPIENT, recipientEntry?.port ?? 4727);

    const participants = [
      participant(SENDER, "mind", 1),
      participant(RECIPIENT, "mind", 2),
    ] as unknown as Participant;

    const { gatedRecipients } = await fanOutToMinds({
      conversationId: CONVERSATION_ID,
      contentBlocks: [{ type: "text", text: "held?" }],
      senderName: SENDER,
      participants,
    });
    assert.deepEqual(gatedRecipients, [RECIPIENT]);
  });

  afterEach(async () => {
    for (const name of MIND_NAMES) await removeMind(name).catch(() => {});
    const db = await getDb();
    await db.delete(minds).where(eq(minds.name, EXTERNAL));
  });
});
