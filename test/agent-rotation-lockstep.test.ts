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

  before(async () => {
    const dir = composeTemplate(templatesRoot, "claude").composedDir;
    composed.push(dir);
    ({ relockstepMessageIds } = await import(resolvePath(dir, "src/lib/recover.js")));
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
});
