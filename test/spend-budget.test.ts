import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { SpendBudget } from "../packages/daemon/src/lib/daemon/spend-budget.js";

const systemDir = () => resolve(process.env.VOLUTE_HOME!, "system");
const stateBase = () => resolve(systemDir(), "state");

describe("SpendBudget", () => {
  // Clean up persisted budget state between tests to ensure isolation
  beforeEach(() => {
    try {
      rmSync(stateBase(), { recursive: true, force: true });
      rmSync(resolve(systemDir(), "spend.json"), { force: true });
    } catch {}
  });

  it("returns ok when no budget is configured", () => {
    const sb = new SpendBudget();
    assert.deepEqual(sb.checkBudget("mind1"), { status: "ok", scope: null });
  });

  it("setBudget / removeBudget lifecycle", async () => {
    const sb = new SpendBudget();
    sb.setBudget("mind1", 10, 1440);
    assert.notEqual(sb.getUsage("mind1"), null);

    await sb.removeBudget("mind1");
    assert.equal(sb.getUsage("mind1"), null);
    assert.deepEqual(sb.checkBudget("mind1"), { status: "ok", scope: null });
  });

  it("setBudget rejects a zero or negative cap", () => {
    const sb = new SpendBudget();
    sb.setBudget("mind1", 0, 1440);
    assert.equal(sb.getUsage("mind1"), null);

    sb.setBudget("mind2", -1, 1440);
    assert.equal(sb.getUsage("mind2"), null);
  });

  it("recordUsage accumulates dollars", () => {
    const sb = new SpendBudget();
    sb.setBudget("mind1", 10, 1440);

    sb.recordUsage("mind1", 1.25);
    assert.equal(sb.getUsage("mind1")!.spentUsd, 1.25);

    sb.recordUsage("mind1", 0.75);
    assert.equal(sb.getUsage("mind1")!.spentUsd, 2);
    assert.equal(sb.getUsage("mind1")!.hasUnpricedTurns, false);
  });

  it("recordUsage is a no-op for minds without a budget", () => {
    const sb = new SpendBudget();
    sb.recordUsage("unknown", 1);
    assert.equal(sb.getUsage("unknown"), null);
  });

  // --- unpriced turns ---

  it("an unpriced turn accumulates nothing but flags the period", () => {
    const sb = new SpendBudget();
    sb.setBudget("mind1", 10, 1440);

    sb.recordUsage("mind1", 2);
    sb.recordUsage("mind1", null);
    sb.recordUsage("mind1", 1);

    const usage = sb.getUsage("mind1")!;
    assert.equal(usage.spentUsd, 3, "null cost adds nothing rather than guessing");
    assert.equal(usage.hasUnpricedTurns, true, "but the period is marked incomplete");
  });

  it("unpriced turns alone never trip the cap", () => {
    const sb = new SpendBudget();
    sb.setBudget("mind1", 1, 1440);
    for (let i = 0; i < 50; i++) sb.recordUsage("mind1", null);
    assert.deepEqual(sb.checkBudget("mind1"), { status: "ok", scope: null });
  });

  it("hasUnpricedTurns is flagged on the system bucket too", () => {
    const sb = new SpendBudget();
    sb.setSystemCap(100);
    sb.recordUsage("mind1", null);
    assert.equal(sb.getSystemUsage()!.hasUnpricedTurns, true);
  });

  it("a period reset clears hasUnpricedTurns", async () => {
    const sb = new SpendBudget();
    sb.setBudget("mind1", 10, 0);
    sb.recordUsage("mind1", null);
    assert.equal(sb.getUsage("mind1")!.hasUnpricedTurns, true);
    await sb.tick();
    assert.equal(sb.getUsage("mind1")!.hasUnpricedTurns, false);
  });

  // --- thresholds ---

  it("checkBudget returns ok under 80%", () => {
    const sb = new SpendBudget();
    sb.setBudget("mind1", 10, 1440);
    sb.recordUsage("mind1", 7);
    assert.deepEqual(sb.checkBudget("mind1"), { status: "ok", scope: null });
  });

  it("checkBudget returns a mind-scoped warning at 80%", () => {
    const sb = new SpendBudget();
    sb.setBudget("mind1", 10, 1440);
    sb.recordUsage("mind1", 8);
    assert.deepEqual(sb.checkBudget("mind1"), { status: "warning", scope: "mind" });
  });

  it("checkBudget keeps warning until acknowledged, then goes quiet", () => {
    const sb = new SpendBudget();
    sb.setBudget("mind1", 10, 1440);
    sb.recordUsage("mind1", 9);
    assert.equal(sb.checkBudget("mind1").status, "warning");
    assert.equal(sb.checkBudget("mind1").status, "warning", "still warning — not yet acknowledged");

    sb.acknowledgeWarning("mind1", "mind");
    assert.deepEqual(sb.checkBudget("mind1"), { status: "ok", scope: null });
  });

  it("checkBudget returns exceeded at and above 100%", () => {
    const sb = new SpendBudget();
    sb.setBudget("a", 10, 1440);
    sb.setBudget("b", 10, 1440);
    sb.recordUsage("a", 10);
    sb.recordUsage("b", 12);
    assert.deepEqual(sb.checkBudget("a"), { status: "exceeded", scope: "mind" });
    assert.deepEqual(sb.checkBudget("b"), { status: "exceeded", scope: "mind" });
  });

  it("a turn that jumps straight past the cap reports exceeded, not warning", () => {
    const sb = new SpendBudget();
    sb.setBudget("mind1", 10, 1440);
    sb.recordUsage("mind1", 7.9); // 79% — under the warning line
    assert.equal(sb.checkBudget("mind1").status, "ok");
    sb.recordUsage("mind1", 2.6); // 105% in one hop
    assert.deepEqual(sb.checkBudget("mind1"), { status: "exceeded", scope: "mind" });
  });

  it("an acknowledged warning does not suppress the later exceeded status", () => {
    const sb = new SpendBudget();
    sb.setBudget("mind1", 10, 1440);
    sb.recordUsage("mind1", 9);
    assert.equal(sb.checkBudget("mind1").status, "warning");
    sb.acknowledgeWarning("mind1", "mind");

    sb.recordUsage("mind1", 1);
    assert.deepEqual(sb.checkBudget("mind1"), { status: "exceeded", scope: "mind" });
  });

  // --- the warning fires once per period, and re-arms after a reset ---

  it("the warning fires exactly once per period and re-arms on reset", async () => {
    const sb = new SpendBudget();
    sb.setBudget("mind1", 10, 0); // 0-minute period: every tick rolls it over

    sb.recordUsage("mind1", 9);
    assert.equal(sb.checkBudget("mind1").status, "warning");
    sb.acknowledgeWarning("mind1", "mind");
    assert.equal(sb.checkBudget("mind1").status, "ok", "already warned this period");

    await sb.tick();

    sb.recordUsage("mind1", 9);
    assert.equal(sb.checkBudget("mind1").status, "warning", "re-armed for the new period");
  });

  // --- system cap ---

  it("the system cap pauses every mind, including ones under their own cap", () => {
    const sb = new SpendBudget();
    sb.setSystemCap(10);
    sb.setBudget("a", 100, 1440);
    sb.setBudget("b", 100, 1440);

    sb.recordUsage("a", 10); // blows the system bucket, nowhere near a's own cap
    assert.equal(sb.getUsage("a")!.spentUsd, 10);
    assert.equal(sb.getUsage("a")!.percentUsed, 10, "a is at 10% of its own cap");

    assert.deepEqual(sb.checkBudget("a"), { status: "exceeded", scope: "system" });
    assert.deepEqual(sb.checkBudget("b"), { status: "exceeded", scope: "system" });
  });

  it("the system bucket wins a tie, so a mind is never falsely told it overspent", () => {
    const sb = new SpendBudget();
    sb.setSystemCap(5);
    sb.setBudget("a", 5, 1440);
    sb.recordUsage("a", 5); // both buckets are exactly full
    assert.deepEqual(sb.checkBudget("a"), { status: "exceeded", scope: "system" });
  });

  it("the system cap warns at 80% with system scope", () => {
    const sb = new SpendBudget();
    sb.setSystemCap(10);
    sb.setBudget("a", 100, 1440);
    sb.recordUsage("a", 8);
    assert.deepEqual(sb.checkBudget("a"), { status: "warning", scope: "system" });
  });

  it("one mind acknowledging a system warning does not silence the others", () => {
    const sb = new SpendBudget();
    sb.setSystemCap(10);
    sb.setBudget("a", 100, 1440);
    sb.setBudget("b", 100, 1440);
    sb.recordUsage("a", 8);

    assert.equal(sb.checkBudget("a").status, "warning");
    sb.acknowledgeWarning("a", "system");
    assert.equal(sb.checkBudget("a").status, "ok");
    assert.equal(sb.checkBudget("b").status, "warning", "b has not been told yet");
  });

  // --- the two caps are announced independently ---

  it("a system warning does not consume the mind's own-cap warning", () => {
    // "The install is near its budget" and "you are near yours" are different facts
    // a mind acts on differently, so one must not swallow the other.
    const sb = new SpendBudget();
    sb.setSystemCap(10);
    sb.setBudget("m", 10.5, 1440);

    sb.recordUsage("m", 8); // 80% of the install, 76% of the mind's own cap
    assert.deepEqual(sb.checkBudget("m"), { status: "warning", scope: "system" });
    sb.acknowledgeWarning("m", "system");
    assert.equal(sb.checkBudget("m").status, "ok", "told about the install once");

    sb.recordUsage("m", 1); // 90% of the install, now 86% of its own cap
    assert.deepEqual(
      sb.checkBudget("m"),
      { status: "warning", scope: "mind" },
      "its own cap still gets its own heads-up",
    );
  });

  it("a mind's own cap is still announced after a system notice and a system rollover", async () => {
    // The two buckets roll on different clocks. A system-scope notice must not
    // leave the mind's own cap unannounceable for the rest of its period.
    mkdirSync(systemDir(), { recursive: true });
    writeFileSync(
      resolve(systemDir(), "spend.json"),
      JSON.stringify({ periodStart: Date.now() - 2 * 86_400_000, spentUsd: 10 }),
    );
    const sb = new SpendBudget();
    sb.setSystemCap(10);
    sb.setBudget("m", 5, 9999); // a long mind period that will not roll
    assert.equal(sb.noteExceeded("m", "system"), true);

    await sb.tick(); // the install's day rolls; the mind's period does not

    sb.recordUsage("m", 6); // now over its own $5 cap
    assert.deepEqual(sb.checkBudget("m"), { status: "exceeded", scope: "mind" });
    assert.equal(sb.noteExceeded("m", "mind"), true, "the mind hears about its own cap");
  });

  it("a mind's period rolling does not re-announce the same system period", async () => {
    const sb = new SpendBudget();
    sb.setSystemCap(10);
    sb.setBudget("m", 100, 0); // mind period rolls on every tick
    sb.recordUsage("m", 8); // 80% of the install

    assert.deepEqual(sb.checkBudget("m"), { status: "warning", scope: "system" });
    sb.acknowledgeWarning("m", "system");
    assert.equal(sb.checkBudget("m").status, "ok");

    await sb.tick(); // the mind's period rolls; the install's day does not

    assert.equal(
      sb.checkBudget("m").status,
      "ok",
      "still the same install-wide period — must not warn twice for it",
    );
    assert.equal(sb.noteExceeded("m", "system"), false, "and must not re-announce exceeded");
  });

  it("raising the cap mid-period lets the new cap be announced", () => {
    // A standing notice named a number that no longer binds, so it must not
    // suppress the notice for the cap that does.
    const sb = new SpendBudget();
    sb.setBudget("m", 10, 9999);
    sb.recordUsage("m", 10);
    assert.equal(sb.noteExceeded("m", "mind"), true);

    sb.setBudget("m", 100, 9999); // the host raises the cap
    sb.recordUsage("m", 95); // 105 total — over the new cap too
    assert.deepEqual(sb.checkBudget("m"), { status: "exceeded", scope: "mind" });
    assert.equal(sb.noteExceeded("m", "mind"), true, "the new cap gets its own notice");
  });

  it("re-setting the same cap re-announces nothing", () => {
    // Every daemon boot and wake calls setBudget with the config's cap.
    const sb = new SpendBudget();
    sb.setBudget("m", 10, 1440);
    sb.recordUsage("m", 10);
    assert.equal(sb.noteExceeded("m", "mind"), true);

    sb.setBudget("m", 10, 1440); // same cap, same period
    assert.equal(sb.noteExceeded("m", "mind"), false, "nothing changed — stay quiet");
  });

  it("with no per-mind caps, every mind is warned — not just the first", () => {
    // The default deployment of an install-wide cap: one number for the whole
    // system, no per-mind caps anywhere. A single shared flag would let the first
    // mind's notice silence all the rest, which is exactly the trapdoor the
    // warning exists to remove.
    const sb = new SpendBudget();
    sb.setSystemCap(10);

    sb.recordUsage("a", 8); // 80% of the install's budget
    assert.deepEqual(sb.checkBudget("a"), { status: "warning", scope: "system" });
    sb.acknowledgeWarning("a", "system");
    assert.equal(sb.checkBudget("a").status, "ok", "a has been told");
    assert.deepEqual(
      sb.checkBudget("b"),
      { status: "warning", scope: "system" },
      "b has its own right to a heads-up",
    );
    sb.acknowledgeWarning("b", "system");
    assert.equal(sb.checkBudget("c").status, "warning", "and so does c");
  });

  it("with no per-mind caps, every mind gets the exceeded notice", () => {
    const sb = new SpendBudget();
    sb.setSystemCap(10);
    sb.recordUsage("a", 10);

    assert.equal(sb.noteExceeded("a", "system"), true);
    assert.equal(sb.noteExceeded("a", "system"), false, "a is not told twice");
    assert.equal(sb.noteExceeded("b", "system"), true, "b is still told");
    assert.equal(sb.noteExceeded("c", "system"), true, "and so is c");
    assert.equal(sb.noteExceeded("b", "system"), false, "b is not told twice either");
  });

  it("a new install-wide period re-arms the notices for every mind", async () => {
    // Age the system period by two days via the persisted file, so the next tick
    // rolls it over — the same path a daemon takes across a day boundary.
    mkdirSync(systemDir(), { recursive: true });
    writeFileSync(
      resolve(systemDir(), "spend.json"),
      JSON.stringify({ periodStart: Date.now() - 2 * 86_400_000, spentUsd: 10 }),
    );

    const sb = new SpendBudget();
    sb.setSystemCap(10);
    assert.equal(sb.getSystemUsage()!.spentUsd, 10, "loaded the aged period");
    assert.equal(sb.noteExceeded("a", "system"), true);
    assert.equal(sb.noteExceeded("b", "system"), true);

    await sb.tick(); // the day has passed — the bucket rolls over
    assert.equal(sb.getSystemUsage()!.spentUsd, 0);

    sb.recordUsage("a", 10);
    assert.equal(sb.noteExceeded("a", "system"), true, "a can be told again");
    assert.equal(sb.noteExceeded("b", "system"), true, "so can b");
  });

  it("retractExceeded re-arms a notice that never made it onto the record", () => {
    // A failed insert must not spend the mind's one notification and leave it
    // paused with no idea why.
    const sb = new SpendBudget();
    sb.setBudget("m", 10, 1440);
    sb.recordUsage("m", 10);
    assert.equal(sb.noteExceeded("m", "mind"), true);
    assert.equal(sb.noteExceeded("m", "mind"), false, "suppressed while it stands");

    sb.retractExceeded("m", "mind");
    assert.equal(sb.noteExceeded("m", "mind"), true, "the mind gets another chance to be told");
  });

  it("retractExceeded works for a mind with no bucket of its own", () => {
    const sb = new SpendBudget();
    sb.setSystemCap(10);
    sb.recordUsage("a", 10);
    assert.equal(sb.noteExceeded("a", "system"), true);
    sb.retractExceeded("a", "system");
    assert.equal(sb.noteExceeded("a", "system"), true);
  });

  it("noteExceeded on the system cap fires once per mind, not once per install", () => {
    const sb = new SpendBudget();
    sb.setSystemCap(10);
    sb.setBudget("a", 100, 1440);
    sb.setBudget("b", 100, 1440);
    sb.recordUsage("a", 10);

    assert.equal(sb.noteExceeded("a", "system"), true);
    assert.equal(sb.noteExceeded("a", "system"), false, "not twice for the same mind");
    assert.equal(sb.noteExceeded("b", "system"), true, "b still gets told");
  });

  it("no system cap means no system bucket", () => {
    const sb = new SpendBudget();
    assert.equal(sb.getSystemUsage(), null);
    sb.setSystemCap(10);
    assert.equal(sb.getSystemUsage()!.capUsd, 10);
    sb.setSystemCap(null);
    assert.equal(sb.getSystemUsage(), null);
  });

  it("the system bucket holds a full day, so a tick does not clear it", async () => {
    const sb = new SpendBudget();
    sb.setSystemCap(10);
    sb.recordUsage("a", 10);
    assert.equal(sb.getSystemUsage()!.spentUsd, 10);
    await sb.tick();
    assert.equal(sb.getSystemUsage()!.spentUsd, 10, "a day has not passed");
  });

  // --- queue (kept intact as the seam for a future delivery gate) ---

  it("enqueue and drain work correctly", () => {
    const sb = new SpendBudget();
    sb.setBudget("mind1", 10, 1440);

    sb.enqueue("mind1", { channel: "ch1", sender: "user1", textContent: "hello" });
    sb.enqueue("mind1", { channel: "ch2", sender: "user2", textContent: "world" });

    assert.equal(sb.getUsage("mind1")!.queueLength, 2);

    const drained = sb.drain("mind1");
    assert.equal(drained.length, 2);
    assert.equal(drained[0].textContent, "hello");
    assert.equal(drained[1].textContent, "world");

    assert.equal(sb.getUsage("mind1")!.queueLength, 0);
  });

  it("enqueue drops oldest when queue is full", () => {
    const sb = new SpendBudget();
    sb.setBudget("mind1", 10, 1440);

    for (let i = 0; i < 100; i++) {
      sb.enqueue("mind1", { channel: "ch", sender: null, textContent: `msg-${i}` });
    }
    assert.equal(sb.getUsage("mind1")!.queueLength, 100);

    sb.enqueue("mind1", { channel: "ch", sender: null, textContent: "msg-100" });
    assert.equal(sb.getUsage("mind1")!.queueLength, 100);

    const drained = sb.drain("mind1");
    assert.equal(drained[0].textContent, "msg-1"); // msg-0 was dropped
    assert.equal(drained[99].textContent, "msg-100");
  });

  it("drain returns empty array for unknown mind", () => {
    const sb = new SpendBudget();
    assert.deepEqual(sb.drain("unknown"), []);
  });

  it("enqueue is a no-op for minds without a budget", () => {
    const sb = new SpendBudget();
    sb.enqueue("unknown", { channel: "ch", sender: null, textContent: "hi" });
    assert.deepEqual(sb.drain("unknown"), []);
  });

  // --- period rollover ---

  it("tick resets expired periods", async () => {
    const sb = new SpendBudget();
    sb.setBudget("mind1", 10, 0); // 0 minutes = always expired on tick

    sb.recordUsage("mind1", 10);
    assert.equal(sb.getUsage("mind1")!.spentUsd, 10);

    await sb.tick();

    assert.equal(sb.getUsage("mind1")!.spentUsd, 0);
  });

  it("tick drains queue on period reset", async () => {
    const sb = new SpendBudget();
    sb.setBudget("mind1", 10, 0);

    sb.enqueue("mind1", { channel: "ch", sender: null, textContent: "queued" });
    assert.equal(sb.getUsage("mind1")!.queueLength, 1);

    await sb.tick();

    assert.equal(sb.getUsage("mind1")!.queueLength, 0);
  });

  it("tick does not reset unexpired periods", async () => {
    const sb = new SpendBudget();
    sb.setBudget("mind1", 10, 9999); // very long period

    sb.recordUsage("mind1", 5);
    await sb.tick();

    assert.equal(sb.getUsage("mind1")!.spentUsd, 5); // NOT reset
  });

  it("tick clears the exceeded flag so the next period notifies again", async () => {
    const sb = new SpendBudget();
    sb.setBudget("mind1", 10, 0);
    sb.recordUsage("mind1", 10);
    assert.equal(sb.noteExceeded("mind1", "mind"), true);
    assert.equal(sb.noteExceeded("mind1", "mind"), false);

    await sb.tick();

    sb.recordUsage("mind1", 10);
    assert.equal(sb.noteExceeded("mind1", "mind"), true, "re-armed for the new period");
  });

  // --- reporting ---

  it("getUsage reports percent, cap, and reset time", () => {
    const sb = new SpendBudget();
    sb.setBudget("mind1", 10, 60);
    sb.recordUsage("mind1", 5);

    const usage = sb.getUsage("mind1")!;
    assert.equal(usage.percentUsed, 50);
    assert.equal(usage.capUsd, 10);
    assert.equal(usage.periodMinutes, 60);
    assert.equal(usage.resetAt, usage.periodStart + 60 * 60_000);
    assert.equal(sb.resetAt("mind1"), usage.resetAt);
  });

  it("resetAt reports the system period separately", () => {
    const sb = new SpendBudget();
    sb.setSystemCap(10);
    sb.setBudget("mind1", 5, 60);
    assert.equal(sb.resetAt("mind1", "system"), sb.getSystemUsage()!.resetAt);
    assert.notEqual(sb.resetAt("mind1", "mind"), sb.resetAt("mind1", "system"));
  });

  it("setBudget preserves existing spend when the cap changes", () => {
    const sb = new SpendBudget();
    sb.setBudget("mind1", 10, 60);
    sb.recordUsage("mind1", 5);

    sb.setBudget("mind1", 20, 120);

    const usage = sb.getUsage("mind1")!;
    assert.equal(usage.spentUsd, 5); // preserved
    assert.equal(usage.capUsd, 20); // updated
    assert.equal(usage.periodMinutes, 120); // updated
  });

  it("minds are tracked independently", () => {
    const sb = new SpendBudget();
    sb.setBudget("a", 10, 1440);
    sb.setBudget("b", 10, 1440);
    sb.recordUsage("a", 10);
    assert.equal(sb.checkBudget("a").status, "exceeded");
    assert.equal(sb.checkBudget("b").status, "ok");
  });

  // --- persistence ---

  it("persists spend across instances", async () => {
    const sb1 = new SpendBudget();
    sb1.setBudget("mind1", 10, 60);
    sb1.recordUsage("mind1", 5);
    await sb1.flush();

    const sb2 = new SpendBudget();
    sb2.setBudget("mind1", 10, 60);
    assert.equal(sb2.getUsage("mind1")!.spentUsd, 5);
  });

  it("removeBudget flushes the spend it is about to drop", async () => {
    // stopMindFull calls this on every stop. flush() skips a mind whose bucket is
    // already gone, so deleting outright would shed a tick's worth of spend on each
    // restart — a crash-looping mind would spend its way past the cap for free.
    const sb1 = new SpendBudget();
    sb1.setBudget("mind1", 10, 60);
    sb1.recordUsage("mind1", 4); // dirty, never flushed by a tick
    await sb1.removeBudget("mind1");

    const sb2 = new SpendBudget();
    sb2.setBudget("mind1", 10, 60);
    assert.equal(sb2.getUsage("mind1")!.spentUsd, 4, "the spend survived the stop");
  });

  it("persists hasUnpricedTurns across instances", async () => {
    const sb1 = new SpendBudget();
    sb1.setBudget("mind1", 10, 60);
    sb1.recordUsage("mind1", null);
    await sb1.flush();

    const sb2 = new SpendBudget();
    sb2.setBudget("mind1", 10, 60);
    assert.equal(sb2.getUsage("mind1")!.hasUnpricedTurns, true);
  });

  it("persists the system bucket across instances", async () => {
    const sb1 = new SpendBudget();
    sb1.setSystemCap(100);
    sb1.recordUsage("mind1", 7.5);
    await sb1.flush();

    const sb2 = new SpendBudget();
    sb2.setSystemCap(100);
    assert.equal(sb2.getSystemUsage()!.spentUsd, 7.5);
  });

  it("persists the acknowledged warning via flush", async () => {
    const sb1 = new SpendBudget();
    sb1.setBudget("mind1", 10, 60);
    sb1.recordUsage("mind1", 9);
    assert.equal(sb1.checkBudget("mind1").status, "warning");
    sb1.acknowledgeWarning("mind1", "mind");
    await sb1.flush();

    const sb2 = new SpendBudget();
    sb2.setBudget("mind1", 10, 60);
    assert.equal(sb2.checkBudget("mind1").status, "ok", "warning was already delivered");
  });

  it("persists queued messages via flush", async () => {
    const sb1 = new SpendBudget();
    sb1.setBudget("mind1", 10, 60);
    sb1.recordUsage("mind1", 10);
    sb1.enqueue("mind1", { channel: "ch1", sender: "user1", textContent: "hello" });
    sb1.enqueue("mind1", { channel: "ch2", sender: null, textContent: "world" });
    await sb1.flush();

    const sb2 = new SpendBudget();
    sb2.setBudget("mind1", 10, 60);
    assert.equal(sb2.getUsage("mind1")!.queueLength, 2);

    const drained = sb2.drain("mind1");
    assert.equal(drained[0].textContent, "hello");
    assert.equal(drained[1].textContent, "world");
  });

  it("discards a budget.json left behind by the token-denominated budget", () => {
    // The old file carried `tokensUsed` and no `spentUsd`. There is no honest
    // conversion from a token count to dollars, and the state is a rolling window
    // rather than history — so it is dropped, not converted.
    const dir = resolve(stateBase(), "legacy-mind");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, "budget.json"),
      JSON.stringify({
        periodStart: Date.now(),
        tokensUsed: 90_000,
        warningInjected: true,
        exceededNotified: true,
        queue: [{ channel: "ch", sender: null, textContent: "old" }],
      }),
    );

    const sb = new SpendBudget();
    sb.setBudget("legacy-mind", 10, 1440);
    const usage = sb.getUsage("legacy-mind")!;
    assert.equal(usage.spentUsd, 0, "token count is not carried over as dollars");
    assert.equal(usage.queueLength, 0, "the whole stale file is dropped");
    assert.equal(sb.checkBudget("legacy-mind").status, "ok");
  });

  it("handles a missing budget state file gracefully", () => {
    const sb = new SpendBudget();
    sb.setBudget("nonexistent-mind", 10, 60);
    assert.equal(sb.getUsage("nonexistent-mind")!.spentUsd, 0);
  });

  it("stop clears the interval it started", async () => {
    const sb = new SpendBudget();
    sb.start();
    assert.notEqual(
      (sb as unknown as { interval: unknown }).interval,
      null,
      "start arms the tick timer",
    );
    await sb.stop();
    assert.equal(
      (sb as unknown as { interval: unknown }).interval,
      null,
      "stop must clear it, or the daemon leaks a timer per restart",
    );
  });

  // --- noteExceeded ---

  it("noteExceeded returns false for an unconfigured mind", () => {
    const sb = new SpendBudget();
    assert.equal(sb.noteExceeded("nobudget", "mind"), false);
  });

  it("noteExceeded returns false while under budget", () => {
    const sb = new SpendBudget();
    sb.setBudget("m", 10, 1440);
    sb.recordUsage("m", 8);
    assert.equal(sb.noteExceeded("m", "mind"), false);
  });

  it("noteExceeded fires exactly once when the cap is crossed", () => {
    const sb = new SpendBudget();
    sb.setBudget("m", 10, 1440);
    sb.recordUsage("m", 12);
    assert.equal(sb.noteExceeded("m", "mind"), true, "first crossing");
    assert.equal(sb.noteExceeded("m", "mind"), false, "not again this period");
    sb.recordUsage("m", 1);
    assert.equal(sb.noteExceeded("m", "mind"), false, "still suppressed");
  });
});
