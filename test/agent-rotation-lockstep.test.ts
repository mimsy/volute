import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { composeTemplate } from "../packages/daemon/src/lib/template/template.js";

/**
 * Regression guard for #764: a duplicate event delivered across an in-place session
 * rotation.
 *
 * A scheduled heartbeat was fully processed by a mind, then the session rotated at
 * the context limit — and the same event prompt was re-submitted verbatim on the new
 * session, because a message folded into the wrap-up turn was never acked and got
 * replayed from `channel.recover()`. Fixing the ack (see template-stale-message-
 * channels.test.ts and message-channel.test.ts) means recover() only ever returns
 * genuinely-unfinished messages, but agent.ts's rotation path re-pushes those into a
 * FRESH channel — which mints its own seq numbers from zero. Without relockstepping,
 * `session.messageIds` (the daemon-facing id per pending message, used for
 * channel/sender routing) drifts out of sync with the new channel's identities.
 *
 * These tests drive `relockstepMessageIds`, the real composed function agent.ts uses
 * at both re-push sites (rotation, idle-reap racing).
 */

const templatesRoot = resolvePath(fileURLToPath(import.meta.url), "../../templates");
const composed: string[] = [];

after(() => {
  for (const dir of composed) rmSync(dir, { recursive: true, force: true });
});

function fakeMsg(text: string) {
  return {
    type: "user" as const,
    session_id: "",
    message: { role: "user" as const, content: [{ type: "text" as const, text }] },
    parent_tool_use_id: null,
  };
}

describe("claude template: relockstepMessageIds", () => {
  let relockstepMessageIds: typeof import("../templates/claude/src/lib/recover.js")["relockstepMessageIds"];
  let markRecovered: typeof import("../templates/claude/src/lib/recover.js")["markRecovered"];
  let RECOVERED_MESSAGE_NOTE: typeof import("../templates/claude/src/lib/recover.js")["RECOVERED_MESSAGE_NOTE"];

  before(async () => {
    const dir = composeTemplate(templatesRoot, "claude").composedDir;
    composed.push(dir);
    ({ relockstepMessageIds, markRecovered, RECOVERED_MESSAGE_NOTE } = await import(
      resolvePath(dir, "src/lib/recover.js")
    ));
  });

  it("carries each entry's id over via its old seq, remapped to the new channel's seq", () => {
    const oldMessageIds = [
      { id: "m1", seq: 5 },
      { id: undefined, seq: 6 }, // e.g. the rotation warning, which has no daemon id
      { id: "m3", seq: 9 },
    ];
    const pending = [
      { msg: fakeMsg("a"), seq: 5 },
      { msg: fakeMsg("b"), seq: 6 },
      { msg: fakeMsg("c"), seq: 9 },
    ];

    let nextSeq = 100;
    const pushedMsgs: unknown[] = [];
    const push = (msg: unknown) => {
      pushedMsgs.push(msg);
      return nextSeq++;
    };

    const result = relockstepMessageIds(pending, oldMessageIds, push, (m) => m);

    assert.deepEqual(
      result.map((e) => e.id),
      ["m1", undefined, "m3"],
      "ids must carry over in the original order, matched by seq (not position)",
    );
    assert.deepEqual(
      result.map((e) => e.seq),
      [100, 101, 102],
      "each entry gets the NEW channel's seq, not the stale old one",
    );
    assert.equal(pushedMsgs.length, 3, "every pending message is re-pushed into the new channel");
  });

  it("matches by seq, not array position — an out-of-order oldMessageIds still resolves correctly", () => {
    // oldMessageIds need not be in the same order recover() returns pending in (it
    // shouldn't happen given how the two arrays are built, but the match must not
    // silently rely on position).
    const oldMessageIds = [
      { id: "later", seq: 20 },
      { id: "earlier", seq: 10 },
    ];
    const pending = [
      { msg: fakeMsg("x"), seq: 10 },
      { msg: fakeMsg("y"), seq: 20 },
    ];
    const push = (() => {
      let n = 0;
      return () => n++;
    })();

    const result = relockstepMessageIds(pending, oldMessageIds, push, (m) => m);
    assert.deepEqual(
      result.map((e) => e.id),
      ["earlier", "later"],
    );
  });

  it("defaults to undefined id for a pending entry with no matching old seq", () => {
    // Defensive: should never happen if push sites stay in lockstep, but a missing
    // match must not throw — it should just carry no daemon id (safe default).
    const push = (() => {
      let n = 0;
      return () => n++;
    })();
    const result = relockstepMessageIds([{ msg: fakeMsg("orphan"), seq: 999 }], [], push, (m) => m);
    assert.deepEqual(result, [{ id: undefined, seq: 0 }]);
  });

  it("applies the transform (recovered-message marker) to every re-pushed message", () => {
    const oldMessageIds = [{ id: "m1", seq: 1 }];
    const pending = [{ msg: fakeMsg("original"), seq: 1 }];
    const pushedMsgs: { message: { content: { text: string }[] } }[] = [];
    const push = (msg: (typeof pushedMsgs)[number]) => {
      pushedMsgs.push(msg);
      return 0;
    };
    const marker = { type: "text" as const, text: "MARKED" };
    const transform = (m: (typeof pushedMsgs)[number]) => ({
      ...m,
      message: { ...m.message, content: [marker, ...m.message.content] },
    });

    relockstepMessageIds(pending, oldMessageIds, push, transform);

    assert.equal(pushedMsgs.length, 1);
    assert.deepEqual(pushedMsgs[0].message.content[0], marker);
    assert.equal(pushedMsgs[0].message.content[1].text, "original");
  });

  it("uses markRecovered as the default transform — every message production re-pushes gets it", () => {
    // All four tests above pass an explicit transform; production never does. This
    // drives the real default so RECOVERED_MESSAGE_NOTE is proven to actually reach
    // a re-pushed message, for both content shapes SDKUserMessage allows.
    const oldMessageIds = [
      { id: "m1", seq: 1 },
      { id: "m2", seq: 2 },
    ];
    const arrayContentMsg = fakeMsg("original array content");
    const stringContentMsg = {
      type: "user" as const,
      session_id: "",
      message: { role: "user" as const, content: "original string content" },
      parent_tool_use_id: null,
    };
    const pending = [
      { msg: arrayContentMsg, seq: 1 },
      { msg: stringContentMsg, seq: 2 },
    ];
    const pushedMsgs: { message: { content: { type: string; text: string }[] } }[] = [];
    const push = (msg: (typeof pushedMsgs)[number]) => {
      pushedMsgs.push(msg);
      return pushedMsgs.length;
    };

    relockstepMessageIds(pending, oldMessageIds, push); // no transform arg — uses markRecovered

    assert.equal(pushedMsgs.length, 2);
    for (const msg of pushedMsgs) {
      assert.equal(msg.message.content[0].type, "text");
      assert.equal(
        msg.message.content[0].text,
        RECOVERED_MESSAGE_NOTE,
        "the note must be the first content block",
      );
    }
    assert.equal(pushedMsgs[0].message.content[1].text, "original array content");
    assert.equal(pushedMsgs[1].message.content[1].text, "original string content");
  });

  it("does not stack the note on a message recovered twice (consecutive rotations)", () => {
    const once = markRecovered(fakeMsg("original"));
    const twice = markRecovered(once);
    const noteBlocks = twice.message.content.filter(
      (b) => "type" in b && b.type === "text" && "text" in b && b.text === RECOVERED_MESSAGE_NOTE,
    );
    assert.equal(noteBlocks.length, 1, "the note must appear once, not once per rotation survived");
  });

  it("reap-race: appending relockstepMessageIds to an existing messageIds array preserves a racing message's entry (#764 regression)", () => {
    // Mirrors agent.ts's idle-reap path: reapSession() deletes the session from the
    // map, then awaits the SDK subprocess's shutdown. During that await, an inbound
    // message can race in via getOrCreateSession(), creating a fresh session and
    // pushing its own {id, seq} into fresh.messageIds — before reapSession ever
    // calls relockstepMessageIds for whatever (rare) input the OLD channel recovers.
    // fresh.messageIds must be appended to, not overwritten, or the racer's entry —
    // and with it its channel/sender routing — is silently discarded.
    const racerEntry = { id: "racer-msg", seq: 0 };
    const freshMessageIds = [racerEntry]; // already populated before the recovered ones arrive

    const oldMessageIds = [{ id: "recovered-msg", seq: 42 }];
    const pending = [{ msg: fakeMsg("recovered"), seq: 42 }];
    let nextFreshSeq = 1; // fresh channel already minted seq 0 for the racer
    const push = () => nextFreshSeq++;

    freshMessageIds.push(...relockstepMessageIds(pending, oldMessageIds, push, (m) => m));

    assert.deepEqual(
      freshMessageIds,
      [racerEntry, { id: "recovered-msg", seq: 1 }],
      "the racer's entry must survive alongside the relockstepped recovered entry",
    );
  });
});
