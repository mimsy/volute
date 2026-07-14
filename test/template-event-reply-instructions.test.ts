import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EVENT_CHANNEL_PREFIX,
  firstReplyableEntry,
  isEventChannel,
  isEventTurn,
} from "../templates/_base/src/lib/event-turn.js";

/**
 * Regression coverage for the bug that made system events look like messages to minds:
 * the pi and codex templates named the event's synthetic `event:<type>:<id>` channel in
 * their reply instructions, so a mind was told to `volute chat send event:orientation:1`.
 * A seed (lucy) obeyed, the send was rejected, and she spent her first turn confused about
 * a message no one had sent her. Reply instructions must never point at an event channel.
 */
describe("event channels are never reply targets", () => {
  it("recognizes a system event's synthetic channel", () => {
    assert.ok(isEventChannel("event:orientation:1"));
    assert.ok(isEventChannel("event:schedule:42"));
    assert.equal(EVENT_CHANNEL_PREFIX, "event:");
  });

  it("does not mistake real channels for event channels", () => {
    assert.ok(!isEventChannel("@psamiton"));
    assert.ok(!isEventChannel("#system"));
    assert.ok(!isEventChannel("discord:my-server/general"));
    assert.ok(!isEventChannel(undefined));
    assert.ok(!isEventChannel(null));
  });

  it("never offers an event channel as a reply target", () => {
    // The exact shape of the lucy bug: the only channel on the turn is the event's.
    const entries = [{ channel: "event:orientation:1", sender: undefined }];
    assert.equal(firstReplyableEntry(entries), undefined);
  });

  it("picks the real channel when a message and an event share a turn", () => {
    const entries = [
      { channel: "event:schedule:42", sender: undefined },
      { channel: "@alice", sender: "alice" },
    ];
    assert.equal(firstReplyableEntry(entries)?.channel, "@alice");
  });

  it("classifies an event-only turn as an event turn", () => {
    assert.ok(isEventTurn([{ channel: "event:orientation:1" }]));
    assert.ok(isEventTurn([{ channel: "event:schedule:42" }, { channel: "event:wake:7" }]));
  });

  it("a turn carrying a real message is not an event turn — someone is waiting", () => {
    assert.ok(!isEventTurn([{ channel: "@alice" }]));
    assert.ok(!isEventTurn([{ channel: "event:schedule:42" }, { channel: "@alice" }]));
    // No channels at all is not an event turn either.
    assert.ok(!isEventTurn([]));
  });

  it("classification tracks the live pending set as it changes", () => {
    // These are the helpers only. That the TEMPLATES actually consult them — and so can't
    // misclassify a queued message/event pair — is asserted against the real composed template
    // code in template-reply-instructions.test.ts; a test built on its own Map cannot show that.
    const pending = new Map<string, { channel: string; sender?: string }>();

    // An event arrives first, then a real message lands while it's still queued.
    pending.set("msg-1", { channel: "event:schedule:42" });
    assert.ok(isEventTurn([...pending.values()]), "event alone → event turn");

    pending.set("msg-2", { channel: "@alice", sender: "alice" });
    assert.ok(!isEventTurn([...pending.values()]), "a waiting person makes it a message turn");
    // And the reply target is the person, never the event channel.
    assert.equal(firstReplyableEntry([...pending.values()])?.channel, "@alice");

    // The message completes and is pruned; the event is still pending and reads as an event.
    pending.delete("msg-2");
    assert.ok(isEventTurn([...pending.values()]));
    assert.equal(firstReplyableEntry([...pending.values()]), undefined);
  });
});
