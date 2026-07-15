import assert from "node:assert";
import { describe, it } from "node:test";
import {
  CARD_TIER,
  feedItemBody,
  historyEventCardModel,
  systemEventLabel,
} from "../packages/web/src/ui/lib/timeline-card";

const base = { type: "inbound", content: "hello", channel: "#general", sender: "james" };

describe("historyEventCardModel", () => {
  it("maps inbound messages to a blue chat card with the sender", () => {
    assert.deepEqual(historyEventCardModel(base, null, "echo"), {
      color: "blue",
      iconKind: "chat",
      title: "#general",
      meta: "james",
      body: { kind: "text", text: "hello" },
      url: "",
    });
  });

  it("defaults inbound sender and missing channel", () => {
    const model = historyEventCardModel(
      { type: "inbound", content: "hi", channel: "", sender: null },
      null,
      "echo",
    );
    assert.equal(model?.title, "message");
    assert.equal(model?.meta, "user");
  });

  it("maps outbound messages to a red chat card with the mind as sender", () => {
    const model = historyEventCardModel({ ...base, type: "outbound" }, null, "echo");
    assert.equal(model?.color, "red");
    assert.equal(model?.iconKind, "chat");
    assert.equal(model?.meta, "echo");
  });

  it("maps system events to a purple gear card with no sender or channel", () => {
    const model = historyEventCardModel(
      { type: "event", content: "the sun rose", channel: "event:schedule:3", sender: null },
      { label: "Schedule: sunrise" },
      "echo",
    );
    assert.deepEqual(model, {
      color: "purple",
      iconKind: "gear",
      title: "Schedule: sunrise",
      meta: "system event",
      body: { kind: "text", text: "the sun rose" },
      url: "",
    });
  });

  it("maps activities using the extension icon, color, body, and nav url", () => {
    const meta = {
      icon: "<svg></svg>",
      color: "yellow",
      author: "iris",
      slug: "my-note",
      url: "/minds/iris/notes/my-note",
      bodyHtml: "note text",
    };
    const model = historyEventCardModel(
      { type: "activity", content: 'iris wrote "My Note"', channel: "", sender: null },
      meta,
      "echo",
    );
    assert.deepEqual(model, {
      color: "yellow",
      icon: "<svg></svg>",
      iconKind: undefined,
      title: 'iris wrote "My Note"',
      meta: "iris",
      body: { kind: "markdown", source: "note text" },
      url: "/minds/iris/notes/my-note",
    });
  });

  it("falls back to the document icon and yellow for bare activities", () => {
    const model = historyEventCardModel(
      { type: "activity", content: "did a thing", channel: "", sender: null },
      null,
      "echo",
    );
    assert.equal(model?.icon, undefined);
    assert.equal(model?.iconKind, "document-lines");
    assert.equal(model?.color, "yellow");
    assert.deepEqual(model?.body, { kind: "none" });
    assert.equal(model?.url, "");
  });

  it("returns null for inline-tier types", () => {
    for (const type of ["text", "thinking", "tool_use", "tool_result", "usage", "summary"]) {
      assert.equal(historyEventCardModel({ ...base, type }, null, "echo"), null);
      assert.equal(CARD_TIER.has(type), false);
    }
  });
});

describe("systemEventLabel", () => {
  it("prefers the stored label", () => {
    assert.equal(systemEventLabel({ label: "Orientation" }, "event:schedule:1"), "Orientation");
  });

  it("falls back to the channel type segment, then 'event'", () => {
    assert.equal(systemEventLabel(null, "event:schedule:1"), "schedule");
    assert.equal(systemEventLabel({}, null), "event");
    assert.equal(systemEventLabel({ label: "" }, ""), "event");
  });
});

describe("feedItemBody", () => {
  it("prefers iframe, then markdown, then none", () => {
    assert.deepEqual(feedItemBody({ iframeUrl: "/ext/p/a.html", bodyHtml: "x" }), {
      kind: "iframe",
      url: "/ext/p/a.html",
    });
    assert.deepEqual(feedItemBody({ bodyHtml: "x" }), { kind: "markdown", source: "x" });
    assert.deepEqual(feedItemBody({}), { kind: "none" });
  });
});
