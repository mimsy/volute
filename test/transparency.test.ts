import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DaemonEvent, EventType } from "../templates/_base/src/lib/daemon-client.js";
import { filterEvent, type TransparencyPreset } from "../templates/_base/src/lib/transparency.js";

function event(type: EventType, content?: string): DaemonEvent {
  return { type, content };
}

describe("filterEvent", () => {
  describe("inbound/outbound always pass through", () => {
    for (const preset of ["transparent", "standard", "private", "silent"] as TransparencyPreset[]) {
      it(`inbound passes in ${preset}`, () => {
        assert.deepEqual(filterEvent(preset, event("inbound", "hi")), event("inbound", "hi"));
      });
      it(`outbound passes in ${preset}`, () => {
        assert.deepEqual(filterEvent(preset, event("outbound", "hi")), event("outbound", "hi"));
      });
    }
  });

  describe("transparent preset", () => {
    const preset: TransparencyPreset = "transparent";

    it("passes thinking", () => {
      assert.ok(filterEvent(preset, event("thinking", "hmm")));
    });

    it("passes text", () => {
      assert.ok(filterEvent(preset, event("text", "hello")));
    });

    it("passes tool_use with content", () => {
      const e = filterEvent(preset, event("tool_use", '{"path":"foo"}'));
      assert.ok(e);
      assert.equal(e!.content, '{"path":"foo"}');
    });

    it("passes tool_result", () => {
      assert.ok(filterEvent(preset, event("tool_result", "output")));
    });

    it("passes log", () => {
      assert.ok(filterEvent(preset, event("log", "info")));
    });

    it("passes usage", () => {
      assert.ok(filterEvent(preset, event("usage")));
    });

    it("passes session_start", () => {
      assert.ok(filterEvent(preset, event("session_start")));
    });

    it("passes done", () => {
      assert.ok(filterEvent(preset, event("done")));
    });
  });

  describe("standard preset", () => {
    const preset: TransparencyPreset = "standard";

    it("drops thinking", () => {
      assert.equal(filterEvent(preset, event("thinking", "hmm")), null);
    });

    it("passes text", () => {
      assert.ok(filterEvent(preset, event("text", "hello")));
    });

    it("tool_use name_only: strips content", () => {
      const e = filterEvent(preset, {
        type: "tool_use",
        content: '{"path":"foo"}',
        metadata: { name: "read" },
      });
      assert.ok(e);
      assert.equal(e!.content, undefined);
      assert.deepEqual(e!.metadata, { name: "read" });
    });

    it("drops tool_result", () => {
      assert.equal(filterEvent(preset, event("tool_result", "output")), null);
    });

    it("passes log", () => {
      assert.ok(filterEvent(preset, event("log", "info")));
    });

    it("passes usage", () => {
      assert.ok(filterEvent(preset, event("usage")));
    });

    it("passes session_start", () => {
      assert.ok(filterEvent(preset, event("session_start")));
    });

    it("passes done", () => {
      assert.ok(filterEvent(preset, event("done")));
    });
  });

  describe("private preset", () => {
    const preset: TransparencyPreset = "private";

    it("drops thinking", () => {
      assert.equal(filterEvent(preset, event("thinking", "hmm")), null);
    });

    it("drops text", () => {
      assert.equal(filterEvent(preset, event("text", "hello")), null);
    });

    it("drops tool_use", () => {
      assert.equal(filterEvent(preset, event("tool_use", "args")), null);
    });

    it("drops tool_result", () => {
      assert.equal(filterEvent(preset, event("tool_result", "output")), null);
    });

    it("drops log", () => {
      assert.equal(filterEvent(preset, event("log", "info")), null);
    });

    it("passes usage", () => {
      assert.ok(filterEvent(preset, event("usage")));
    });

    it("passes session_start", () => {
      assert.ok(filterEvent(preset, event("session_start")));
    });

    it("passes done", () => {
      assert.ok(filterEvent(preset, event("done")));
    });
  });

  describe("silent preset", () => {
    const preset: TransparencyPreset = "silent";

    it("drops thinking", () => {
      assert.equal(filterEvent(preset, event("thinking")), null);
    });

    it("drops text", () => {
      assert.equal(filterEvent(preset, event("text")), null);
    });

    it("drops tool_use", () => {
      assert.equal(filterEvent(preset, event("tool_use")), null);
    });

    it("drops tool_result", () => {
      assert.equal(filterEvent(preset, event("tool_result")), null);
    });

    it("drops log", () => {
      assert.equal(filterEvent(preset, event("log")), null);
    });

    it("drops usage", () => {
      assert.equal(filterEvent(preset, event("usage")), null);
    });

    it("drops session_start", () => {
      assert.equal(filterEvent(preset, event("session_start")), null);
    });

    it("drops done", () => {
      assert.equal(filterEvent(preset, event("done")), null);
    });
  });

  describe("unknown event types", () => {
    it("passes unknown types in transparent mode", () => {
      const e = { type: "custom_event" as EventType, content: "data" };
      assert.ok(filterEvent("transparent", e));
    });

    it("drops unknown types in standard mode", () => {
      const e = { type: "custom_event" as EventType, content: "data" };
      assert.equal(filterEvent("standard", e), null);
    });

    it("drops unknown types in private mode", () => {
      const e = { type: "custom_event" as EventType, content: "data" };
      assert.equal(filterEvent("private", e), null);
    });

    it("drops unknown types in silent mode", () => {
      const e = { type: "custom_event" as EventType, content: "data" };
      assert.equal(filterEvent("silent", e), null);
    });
  });
});
