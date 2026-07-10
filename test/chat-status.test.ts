import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Mind } from "../packages/api/src/types.js";
import { chatStatus, formatWakeTime } from "../packages/web/src/ui/components/chat/chat-status.js";

function mind(overrides: Partial<Mind>): Mind {
  return {
    name: "atlas",
    created: "2026-01-01",
    status: "running",
    channels: [],
    ...overrides,
  };
}

describe("chatStatus", () => {
  it("returns null for a healthy running mind and for no mind", () => {
    assert.equal(chatStatus(mind({}), true), null);
    assert.equal(chatStatus(undefined, true), null);
  });

  it("stopped: shows the Start button only to admins", () => {
    const admin = chatStatus(mind({ status: "stopped" }), true);
    assert.equal(admin?.kind, "stopped");
    assert.equal(admin?.text, "atlas isn't running");
    assert.equal(admin?.showStart, true);

    const user = chatStatus(mind({ status: "stopped" }), false);
    assert.equal(user?.showStart, false);
  });

  it("starting: waking up", () => {
    const s = chatStatus(mind({ status: "starting" }), false);
    assert.equal(s?.kind, "starting");
    assert.equal(s?.text, "atlas is waking up…");
  });

  it("sleeping: includes the wake time when set, plain otherwise", () => {
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    const withWake = chatStatus(mind({ status: "sleeping", wakeAt: noon.toISOString() }), false);
    assert.equal(withWake?.kind, "sleeping");
    assert.equal(withWake?.text, "atlas is asleep — waking at 12:00 PM");

    const noWake = chatStatus(mind({ status: "sleeping", wakeAt: null }), false);
    assert.equal(noWake?.text, "atlas is asleep");
  });

  it("prefers the display name when set", () => {
    const s = chatStatus(mind({ status: "stopped", displayName: "Atlas" }), false);
    assert.equal(s?.text, "Atlas isn't running");
  });

  it("last turn failed: maps known reasons to short labels and keeps the detail", () => {
    const s = chatStatus(
      mind({
        lastError: {
          kind: "turn_error",
          reason: "auth_error",
          detail: "Your last turn failed because your model credentials were rejected.",
          at: "2026-07-10 12:00:00",
        },
      }),
      false,
    );
    assert.equal(s?.kind, "error");
    assert.equal(s?.text, "atlas's last turn failed — the model credentials were rejected");
    assert.match(s?.detail ?? "", /credentials were rejected/);
  });

  it("last turn failed: unknown reasons get a generic label", () => {
    const s = chatStatus(
      mind({
        lastError: { kind: "turn_error", reason: "unknown", detail: "raw", at: "" },
      }),
      false,
    );
    assert.equal(s?.text, "atlas's last turn failed — an unexpected error");
  });

  it("crash and startup failures get their own phrasing", () => {
    const crash = chatStatus(
      mind({ lastError: { kind: "crash", reason: "process_crash", detail: "d", at: "" } }),
      false,
    );
    assert.equal(crash?.text, "atlas's process crashed");

    const startup = chatStatus(
      mind({ lastError: { kind: "startup", reason: "startup_failed", detail: "d", at: "" } }),
      false,
    );
    assert.equal(startup?.text, "atlas failed to start");
  });

  it("process state outranks a stale failure", () => {
    const s = chatStatus(
      mind({
        status: "sleeping",
        lastError: { kind: "turn_error", reason: "network", detail: "d", at: "" },
      }),
      false,
    );
    assert.equal(s?.kind, "sleeping");
  });

  it("stopped + crash shows the actionable stopped state, not the crash", () => {
    // The most common combined state: a crashed mind is stopped AND carries a
    // crash notice. Stopped (with Start) is the actionable line.
    const s = chatStatus(
      mind({
        status: "stopped",
        lastError: { kind: "crash", reason: "process_crash", detail: "d", at: "" },
      }),
      true,
    );
    assert.equal(s?.kind, "stopped");
    assert.equal(s?.showStart, true);
  });

  it("handles a detail-less lastError (non-admin API projection)", () => {
    const s = chatStatus(
      mind({ lastError: { kind: "turn_error", reason: "rate_limit", at: "" } }),
      false,
    );
    assert.equal(s?.text, "atlas's last turn failed — the model provider's rate limit was hit");
    assert.equal(s?.detail, undefined);
  });
});

describe("formatWakeTime", () => {
  it("returns null for missing or unparseable input", () => {
    assert.equal(formatWakeTime(null), null);
    assert.equal(formatWakeTime(undefined), null);
    assert.equal(formatWakeTime("not-a-date"), null);
  });

  it("shows just the time for a wake later today", () => {
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    assert.equal(formatWakeTime(noon.toISOString()), "12:00 PM");
  });

  it("adds the weekday for a wake on another day", () => {
    const future = new Date();
    future.setDate(future.getDate() + 3);
    future.setHours(12, 0, 0, 0);
    const expectedDay = future.toLocaleDateString("en-US", { weekday: "long" });
    assert.equal(formatWakeTime(future.toISOString()), `12:00 PM on ${expectedDay}`);
  });
});
