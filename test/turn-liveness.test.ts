import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { getTypingMap } from "../packages/daemon/src/lib/chat/typing.js";
import { initMindManager } from "../packages/daemon/src/lib/daemon/mind-manager.js";
import { initSpendBudget } from "../packages/daemon/src/lib/daemon/spend-budget.js";
import { reconcileWedgedTurns } from "../packages/daemon/src/lib/daemon/summarizer.js";
import { handleMindEvent } from "../packages/daemon/src/lib/daemon/turn-lifecycle.js";
import { hasTurnSlot } from "../packages/daemon/src/lib/daemon/turn-slots.js";
import { clearMind, getActiveTurnId } from "../packages/daemon/src/lib/daemon/turn-tracker.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  type DeliveryManager,
  initDeliveryManager,
} from "../packages/daemon/src/lib/delivery/delivery-manager.js";
import { mindHistory, turns } from "../packages/daemon/src/lib/schema.js";

/**
 * A turn is beside another process's on a thread only while that process runs (#1177). Its
 * own file: it stands up the mind manager, whose `isRunning` every turn here is read through.
 */

let dm: DeliveryManager;
/** The manager's own record of running processes (`isRunning` reads it). */
let running: Map<string, unknown>;
before(() => {
  dm = initDeliveryManager();
  running = (initMindManager() as any).minds;
  try {
    initSpendBudget();
  } catch {
    // already initialized
  }
});
after(() => dm.dispose());

const MIND = "tl-live";
const VARIANT = `${MIND}@v`;

// Bounded so a hang fails in seconds instead of stalling pre-push for half an hour: this
// file has sat at 0% CPU inside the full local suite (#1386). Its hooks are synchronous, so
// the bound on the tests is the bound on the file.
describe("a turn beside another process's on its thread", { timeout: 30_000 }, () => {
  it("keeps the indicator and the slot only while that process is running", async () => {
    running.set(MIND, {});
    running.set(VARIANT, {});
    (dm as any).addOutstanding(MIND, "s1", "v1", VARIANT);
    await handleMindEvent(MIND, { type: "text", session: "s1", content: "parent" });
    await handleMindEvent(
      MIND,
      { type: "text", session: "s1", messageId: "v1", content: "v" },
      VARIANT,
    );
    const typing = getTypingMap();
    typing.set("@bob", MIND, { persistent: true });

    // The parent stops without clearing (as on a crash mid-handling): its turn is no
    // longer beside the variant's.
    running.delete(MIND);
    await handleMindEvent(
      MIND,
      { type: "done", session: "s1", messageId: "v1", covers: ["v1"] },
      VARIANT,
    );
    assert.ok(!typing.get("@bob").includes(MIND), "the indicator clears");
    assert.equal(hasTurnSlot(MIND, "s1"), false, "the slot goes back");

    dm.clearMindSessions(MIND);
    await clearMind(MIND);
    await clearMind(VARIANT);
    const db = await getDb();
    await db.delete(mindHistory).where(eq(mindHistory.mind, MIND));
    await db.delete(turns).where(eq(turns.mind, MIND));
  });

  it("sweeping a stopped process's turn leaves the thread's other deliveries be", async () => {
    running.set(MIND, {});
    running.delete(VARIANT);
    (dm as any).addOutstanding(MIND, "s2", "p1", MIND);
    await handleMindEvent(MIND, { type: "text", session: "s2", messageId: "p1", content: "p" });
    // A variant that isn't running left a turn on the thread.
    await handleMindEvent(MIND, { type: "text", session: "s2", content: "v" }, VARIANT);
    await reconcileWedgedTurns(0);
    assert.equal(getActiveTurnId(MIND, "s2", VARIANT), undefined, "the stopped one's is swept");
    assert.equal(dm.isSessionBusy(MIND, "s2"), true, "the parent's delivery is still out");
    assert.equal(hasTurnSlot(MIND, "s2"), true);

    dm.clearMindSessions(MIND);
    await clearMind(MIND);
    await clearMind(VARIANT);
    const db = await getDb();
    await db.delete(mindHistory).where(eq(mindHistory.mind, MIND));
    await db.delete(turns).where(eq(turns.mind, MIND));
  });
});
