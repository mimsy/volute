import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  activityColor,
  activityNavUrl,
  activityPeekBody,
  peekKey,
  shouldRenderPeek,
} from "../packages/web/src/ui/lib/peek";

describe("peekKey", () => {
  it("builds stable, kind-scoped keys", () => {
    assert.equal(peekKey("chat", "turn-1", "conv-9"), "chat:turn-1:conv-9");
    assert.equal(peekKey("activity", "turn-1", 42), "activity:turn-1:42");
  });

  it("does not collide across kinds or turns for the same item id", () => {
    assert.notEqual(peekKey("chat", "turn-1", "x"), peekKey("activity", "turn-1", "x"));
    assert.notEqual(peekKey("activity", "turn-1", 1), peekKey("activity", "turn-2", 1));
  });

  it("does not collide for colon-bearing item ids on the same turn (turn ids are UUIDs)", () => {
    assert.notEqual(
      peekKey("chat", "turn-1", "discord:a/b"),
      peekKey("chat", "turn-1", "discord:a/c"),
    );
  });
});

describe("activityPeekBody", () => {
  it("prefers a live iframe when iframeUrl is present", () => {
    assert.deepEqual(activityPeekBody({ iframeUrl: "/x", bodyHtml: "# hi" }), {
      kind: "iframe",
      url: "/x",
    });
  });

  it("falls back to markdown when only bodyHtml is present", () => {
    assert.deepEqual(activityPeekBody({ bodyHtml: "# hi" }), {
      kind: "markdown",
      source: "# hi",
    });
  });

  it("renders nothing when neither is present", () => {
    assert.deepEqual(activityPeekBody(null), { kind: "none" });
    assert.deepEqual(activityPeekBody({ color: "blue" }), { kind: "none" });
  });

  it("ignores non-string metadata fields", () => {
    assert.deepEqual(activityPeekBody({ iframeUrl: 5, bodyHtml: 7 }), {
      kind: "none",
    });
  });
});

describe("activityNavUrl", () => {
  it("navigates to the iframe url when present", () => {
    assert.equal(activityNavUrl({ iframeUrl: "/pages/a" }, "mind"), "/pages/a");
  });

  it("builds a note url from slug, defaulting author to the mind", () => {
    assert.equal(activityNavUrl({ slug: "my-note" }, "echo"), "/minds/echo/notes/my-note");
    assert.equal(
      activityNavUrl({ slug: "my-note", author: "iris" }, "echo"),
      "/minds/iris/notes/my-note",
    );
  });

  it("returns empty when there is nothing to navigate to", () => {
    assert.equal(activityNavUrl(null, "mind"), "");
    assert.equal(activityNavUrl({ color: "red" }, "mind"), "");
  });

  it("an explicit empty-string iframeUrl wins over slug (no navigation, matching original inline logic)", () => {
    assert.equal(activityNavUrl({ iframeUrl: "", slug: "my-note" }, "echo"), "");
  });
});

describe("activityColor", () => {
  it("uses the metadata color when a string", () => {
    assert.equal(activityColor({ color: "green" }), "green");
  });

  it("defaults to yellow", () => {
    assert.equal(activityColor(null), "yellow");
    assert.equal(activityColor({ color: 3 }), "yellow");
  });
});

// Guard the core perf property: hidden popovers render no content. The component
// gates each popover's markdown/iframe behind `shouldRenderPeek(revealedPeeks,
// peekKey(...))` — the same function exercised here — so an empty reveal set
// yields zero renders for any number of collapsed peeks.
describe("lazy peek reveal gating (shouldRenderPeek)", () => {
  it("renders no popover content until a peek is revealed", () => {
    const revealed = new Set<string>();
    const keys = Array.from({ length: 500 }, (_, i) =>
      i % 2 === 0 ? peekKey("chat", `turn-${i}`, `conv-${i}`) : peekKey("activity", `turn-${i}`, i),
    );
    const rendered = keys.filter((k) => shouldRenderPeek(revealed, k));
    assert.equal(rendered.length, 0);
  });

  it("renders only the revealed peek, leaving siblings hidden", () => {
    const revealed = new Set<string>();
    const a = peekKey("chat", "turn-1", "conv-1");
    const b = peekKey("activity", "turn-1", 2);
    revealed.add(a);
    assert.equal(shouldRenderPeek(revealed, a), true);
    assert.equal(shouldRenderPeek(revealed, b), false);
  });
});
