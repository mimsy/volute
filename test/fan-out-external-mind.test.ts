import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq, inArray } from "drizzle-orm";
import { getOrCreateMindUser } from "../packages/daemon/src/lib/auth.js";
import {
  initMindManager,
  tryGetMindManager,
} from "../packages/daemon/src/lib/daemon/mind-manager.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  initDeliveryManager,
  tryGetDeliveryManager,
} from "../packages/daemon/src/lib/delivery/delivery-manager.js";
import { fanOutToMinds } from "../packages/daemon/src/lib/delivery/fan-out.js";
import { addMind, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import { deliveryQueue, minds, users } from "../packages/daemon/src/lib/schema.js";
import log from "../packages/daemon/src/lib/util/logger.js";

const NATIVE = "r2-fanout-native"; // running, has a registry row
const DOWN_NATIVE = "r2-fanout-down"; // has a registry row, not running
const EXTERNAL = "r2-fanout-external"; // mind-typed user, NO registry row
const HUMAN = "r2-fanout-human"; // the sender

const MIND_NAMES = [NATIVE, DOWN_NATIVE];
const TEST_USERNAMES = [NATIVE, DOWN_NATIVE, EXTERNAL, HUMAN];

const CONVERSATION_ID = "r2-fanout-conversation";

type Participant = Parameters<typeof fanOutToMinds>[0]["participants"];

async function cleanup() {
  const db = await getDb();
  await db.delete(users).where(inArray(users.username, TEST_USERNAMES));
  await db.delete(deliveryQueue).where(inArray(deliveryQueue.mind, MIND_NAMES));
  for (const name of MIND_NAMES) {
    await db.delete(minds).where(eq(minds.name, name));
  }
  tracked()?.delete(NATIVE);
}

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

/** Collect log.warn output for the duration of a call. */
async function captureWarnings(fn: () => Promise<void>): Promise<string[]> {
  const warnings: string[] = [];
  const original = log.warn;
  log.warn = (msg: string, ...rest: unknown[]) => {
    warnings.push(String(msg));
    return original.call(log, msg, ...rest);
  };
  try {
    await fn();
  } finally {
    log.warn = original;
  }
  return warnings;
}

/** delivery_queue rows are written before the (here, failing) HTTP send, so they
 *  are the observable proof that deliverMessage actually ran for a mind. */
async function queuedMinds(): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .select({ mind: deliveryQueue.mind })
    .from(deliveryQueue)
    .where(inArray(deliveryQueue.mind, MIND_NAMES))
    .all();
  return rows.map((r) => r.mind);
}

/** fan-out delivers fire-and-forget, so poll briefly for the queue row. */
async function waitForQueued(mind: string, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await queuedMinds()).includes(mind)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe("fan-out with an external (registry-row-less) mind participant", () => {
  beforeEach(async () => {
    if (!tryGetMindManager()) initMindManager();
    // deliverMessage routes through the delivery manager; without it every send
    // fails early and the queue row (our proof of delivery) is never written.
    if (!tryGetDeliveryManager()) initDeliveryManager();
    await cleanup();
  });
  afterEach(cleanup);

  it("delivers to the running native mind, silently skips the external mind, and warns only for the down native one", async () => {
    // (a) a running native mind, (b) an external mind-typed user with no minds row,
    // (c) a human sender — plus a down NATIVE mind as the warn control.
    const nativeEntry = await addMind(NATIVE, 4711);
    await addMind(DOWN_NATIVE, 4712);
    markRunning(NATIVE, nativeEntry?.port ?? 4711);

    await getOrCreateMindUser(NATIVE);
    await getOrCreateMindUser(DOWN_NATIVE);
    const externalUser = await getOrCreateMindUser(EXTERNAL);
    // The external mind is a users row only — no registry row is what makes it external.
    const db = await getDb();
    assert.equal(externalUser.user_type, "mind");
    assert.equal(await db.select().from(minds).where(eq(minds.name, EXTERNAL)).get(), undefined);

    const participants = [
      { userId: 1, username: HUMAN, userType: "human", role: "member" },
      { userId: 2, username: NATIVE, userType: "mind", role: "member" },
      { userId: externalUser.id, username: EXTERNAL, userType: "mind", role: "member" },
      { userId: 4, username: DOWN_NATIVE, userType: "mind", role: "member" },
    ] as unknown as Participant;

    const warnings = await captureWarnings(async () => {
      await fanOutToMinds({
        conversationId: CONVERSATION_ID,
        contentBlocks: [{ type: "text", text: "hello minds" }],
        senderName: HUMAN,
        senderId: null,
        participants,
      });
    });

    // The external mind is expected steady-state "not running": no warn spam.
    // This is the assertion that fails when the registry guard is reverted.
    assert.ok(
      !warnings.some((w) => w.includes(EXTERNAL)),
      `external mind must not warn, got: ${JSON.stringify(warnings)}`,
    );
    // A stopped NATIVE mind is a real anomaly and must still be traceable (#434).
    assert.ok(
      warnings.some((w) => w.includes(DOWN_NATIVE) && w.includes("not running")),
      `down native mind must still warn, got: ${JSON.stringify(warnings)}`,
    );

    // One row-less participant must not abort fan-out for the others: (a) still gets it.
    assert.ok(await waitForQueued(NATIVE), "running native mind must still be delivered to");
    // ...and the external mind is filtered out of delivery entirely — it pulls, never pushed.
    assert.ok(
      !(await queuedMinds()).includes(EXTERNAL),
      "external mind must not be pushed a message",
    );
  });

  it("does not throw when every mind participant is external", async () => {
    const externalUser = await getOrCreateMindUser(EXTERNAL);
    const participants = [
      { userId: 1, username: HUMAN, userType: "human", role: "member" },
      { userId: externalUser.id, username: EXTERNAL, userType: "mind", role: "member" },
    ] as unknown as Participant;

    const warnings = await captureWarnings(async () => {
      await fanOutToMinds({
        conversationId: CONVERSATION_ID,
        contentBlocks: [{ type: "text", text: "quiet" }],
        senderName: HUMAN,
        senderId: null,
        participants,
      });
    });
    assert.deepEqual(
      warnings.filter((w) => w.includes(EXTERNAL)),
      [],
    );
  });

  afterEach(async () => {
    for (const name of MIND_NAMES) await removeMind(name).catch(() => {});
  });
});
