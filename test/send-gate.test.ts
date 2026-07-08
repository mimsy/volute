import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { getOrCreateMindUser } from "../packages/daemon/src/lib/auth.js";
import {
  _resetAllForTest,
  _stateSizeForTest,
  checkStaleSend,
  clearMind,
  formatHoldNotice,
  onDeliveredToMind,
  resetTurn,
} from "../packages/daemon/src/lib/delivery/send-gate.js";
import { addMessage, createConversation } from "../packages/daemon/src/lib/events/conversations.js";

afterEach(() => _resetAllForTest());

async function makeMindDM(a: string, b: string): Promise<string> {
  const ua = await getOrCreateMindUser(a);
  const ub = await getOrCreateMindUser(b);
  const conv = await createConversation({ participantIds: [ua.id, ub.id] });
  return conv.id;
}

async function post(convId: string, sender: string, text: string): Promise<void> {
  await addMessage(convId, "user", sender, [{ type: "text", text }]);
}

describe("send-gate stale-send hold", () => {
  it("holds a send when another participant posted after the turn baseline", async () => {
    const conv = await makeMindDM("gateA", "gateB");
    await post(conv, "gateB", "hello A"); // trigger
    await onDeliveredToMind("gateA", conv); // opens turn; baseline = "hello A"
    await post(conv, "gateB", "wait, also this"); // arrived while A composes

    const r = await checkStaleSend("gateA", conv, ["gateA"]);
    assert.equal(r.held, true);
    assert.equal(r.unseen?.length, 1);
    assert.equal(r.unseen?.[0].text, "wait, also this");
    assert.equal(r.unseen?.[0].sender, "gateB");
  });

  it("posts (no hold) when nothing new arrived since the baseline", async () => {
    const conv = await makeMindDM("gateC", "gateD");
    await post(conv, "gateD", "hi");
    await onDeliveredToMind("gateC", conv);

    assert.equal((await checkStaleSend("gateC", conv, ["gateC"])).held, false);
  });

  it("ignores the sending mind's own messages", async () => {
    const conv = await makeMindDM("gateE", "gateF");
    await post(conv, "gateF", "hi");
    await onDeliveredToMind("gateE", conv);
    await post(conv, "gateE", "my own line since"); // self — must not count

    assert.equal((await checkStaleSend("gateE", conv, ["gateE"])).held, false);
  });

  it("holds at most once per turn", async () => {
    const conv = await makeMindDM("gateG", "gateH");
    await post(conv, "gateH", "hi");
    await onDeliveredToMind("gateG", conv);

    await post(conv, "gateH", "new1");
    assert.equal((await checkStaleSend("gateG", conv, ["gateG"])).held, true);

    await post(conv, "gateH", "new2");
    assert.equal(
      (await checkStaleSend("gateG", conv, ["gateG"])).held,
      false,
      "already held once this turn — the resend should go through",
    );
  });

  it("gates per-conversation — a new message on another channel doesn't hold", async () => {
    const convX = await makeMindDM("gateI", "gateJ");
    const convY = await makeMindDM("gateI", "gateK");
    await post(convX, "gateJ", "x1");
    await post(convY, "gateK", "y1");
    await onDeliveredToMind("gateI", convX);
    await onDeliveredToMind("gateI", convY);

    await post(convX, "gateJ", "x-new"); // new only on X

    assert.equal(
      (await checkStaleSend("gateI", convY, ["gateI"])).held,
      false,
      "new message on X must not hold a send to Y",
    );
    assert.equal((await checkStaleSend("gateI", convX, ["gateI"])).held, true);
  });

  it("does not gate a send when no turn is open (proactive/mind-initiated)", async () => {
    const conv = await makeMindDM("gateN", "gateO");
    await post(conv, "gateO", "hi"); // exists, but no delivery opened a turn
    assert.equal((await checkStaleSend("gateN", conv, ["gateN"])).held, false);
  });

  it("resets the baseline on done so the next turn can hold again", async () => {
    const conv = await makeMindDM("gateL", "gateM");
    await post(conv, "gateM", "hi");
    await onDeliveredToMind("gateL", conv);
    await post(conv, "gateM", "new");
    assert.equal((await checkStaleSend("gateL", conv, ["gateL"])).held, true);

    resetTurn("gateL"); // turn ends

    await onDeliveredToMind("gateL", conv); // new turn; baseline = latest
    assert.equal(
      (await checkStaleSend("gateL", conv, ["gateL"])).held,
      false,
      "fresh baseline — nothing new yet",
    );

    await post(conv, "gateM", "another");
    assert.equal(
      (await checkStaleSend("gateL", conv, ["gateL"])).held,
      true,
      "a new message in the fresh turn holds again",
    );
  });

  it("resetTurn frees the mind's state instead of leaking an entry per conversation", async () => {
    const conv1 = await makeMindDM("gateN", "gateO");
    const conv2 = await makeMindDM("gateN", "gateP");
    await onDeliveredToMind("gateN", conv1);
    await onDeliveredToMind("gateN", conv2);
    assert.equal(_stateSizeForTest(), 1, "one mind tracked");

    resetTurn("gateN");
    assert.equal(_stateSizeForTest(), 0, "state fully freed after the turn completes");
  });

  it("clearMind drops a mind's gate state (mind stop)", async () => {
    const conv = await makeMindDM("gateQ", "gateR");
    await onDeliveredToMind("gateQ", conv);
    assert.equal(_stateSizeForTest(), 1);

    clearMind("gateQ");
    assert.equal(_stateSizeForTest(), 0);
  });

  it("formats a readable hold notice", () => {
    const notice = formatHoldNotice("#bardo", [
      { sender: "whorl", text: "saw it too" },
      { sender: "gardener", text: "one more thing" },
    ]);
    assert.match(notice, /2 newer messages arrived on #bardo/);
    assert.match(notice, /whorl:/);
    assert.match(notice, /gardener:/);
    assert.match(notice, /NOT posted/);
  });
});
