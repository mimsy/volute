import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearDeliveredNotices,
  drainNotices,
  formatNotices,
  type Notice,
  recordNotice,
} from "../packages/daemon/src/lib/daemon/notices.js";

let counter = 0;
function uniqueMind(): string {
  counter += 1;
  return `notices-test-${process.pid}-${counter}`;
}

describe("notices", () => {
  it("records and drains notices per session, oldest first", async () => {
    const mind = uniqueMind();
    await recordNotice({
      mind,
      session: "main",
      kind: "turn_error",
      reason: "auth_error",
      detail: "first",
    });
    await recordNotice({
      mind,
      session: "main",
      kind: "turn_error",
      reason: "rate_limit",
      detail: "second",
    });
    // Different session — must not leak into "main"
    await recordNotice({
      mind,
      session: "other",
      kind: "crash",
      reason: "process_crash",
      detail: "elsewhere",
    });

    const main = await drainNotices(mind, "main");
    assert.deepEqual(
      main.map((n) => n.detail),
      ["first", "second"],
    );

    const other = await drainNotices(mind, "other");
    assert.deepEqual(
      other.map((n) => n.detail),
      ["elsewhere"],
    );
  });

  it("clears delivered notices up to a watermark id, leaving newer ones queued", async () => {
    const mind = uniqueMind();
    await recordNotice({
      mind,
      session: "main",
      kind: "turn_error",
      reason: "unknown",
      detail: "a",
    });
    await recordNotice({
      mind,
      session: "main",
      kind: "turn_error",
      reason: "unknown",
      detail: "b",
    });

    const drained = await drainNotices(mind, "main");
    assert.equal(drained.length, 2);
    const watermark = Math.max(...drained.map((n) => n.id));

    // A notice created AFTER the drain (id > watermark) must survive the clear.
    await recordNotice({
      mind,
      session: "main",
      kind: "budget",
      reason: "token_budget",
      detail: "c",
    });

    await clearDeliveredNotices(mind, "main", watermark);

    const remaining = await drainNotices(mind, "main");
    assert.deepEqual(
      remaining.map((n) => n.detail),
      ["c"],
    );
  });

  it("drain returns nothing once everything is cleared", async () => {
    const mind = uniqueMind();
    await recordNotice({
      mind,
      session: "main",
      kind: "turn_error",
      reason: "unknown",
      detail: "x",
    });
    const drained = await drainNotices(mind, "main");
    await clearDeliveredNotices(mind, "main", Math.max(...drained.map((n) => n.id)));
    assert.deepEqual(await drainNotices(mind, "main"), []);
  });

  it("caps retained notices per session", async () => {
    const mind = uniqueMind();
    for (let i = 0; i < 130; i++) {
      await recordNotice({
        mind,
        session: "main",
        kind: "turn_error",
        reason: "network",
        detail: `n${i}`,
      });
    }
    const drained = await drainNotices(mind, "main", 1000);
    assert.equal(drained.length, 100, "should retain at most the cap (100)");
    // The newest must be kept; the oldest trimmed.
    assert.ok(drained.some((n) => n.detail === "n129"));
    assert.ok(!drained.some((n) => n.detail === "n0"));
  });
});

describe("formatNotices", () => {
  const base = {
    id: 1,
    mind: "m",
    session: "s",
    kind: "turn_error",
    raw: null,
  };
  const at = (t: string) => `2026-06-22 ${t}:00`;

  it("returns null for an empty list", () => {
    assert.equal(formatNotices([]), null);
  });

  it("uses singular phrasing for a single failure", () => {
    const notices = [
      { ...base, reason: "auth_error", detail: "creds", created_at: at("14:02") },
    ] as Notice[];
    const out = formatNotices(notices)!;
    assert.match(out, /1 turn failed/);
    assert.ok(!/1 turns/.test(out));
  });

  it("groups same-reason failures with a count and time span", () => {
    const notices = [
      { ...base, id: 1, reason: "network", detail: "net", created_at: at("14:02") },
      { ...base, id: 2, reason: "network", detail: "net", created_at: at("14:31") },
    ] as Notice[];
    const out = formatNotices(notices)!;
    assert.match(out, /2 turns failed \(14:02–14:31 UTC\)/);
  });

  it("renders one line per distinct reason", () => {
    const notices = [
      { ...base, id: 1, reason: "auth_error", detail: "creds", created_at: at("14:02") },
      { ...base, id: 2, reason: "network", detail: "net", created_at: at("14:05") },
      { ...base, id: 3, reason: "network", detail: "net", created_at: at("14:06") },
    ] as Notice[];
    const out = formatNotices(notices)!;
    const lines = out.split("\n").filter((l) => l.startsWith("- "));
    assert.equal(lines.length, 2);
    assert.ok(lines.some((l) => /1 turn failed/.test(l) && /creds/.test(l)));
    assert.ok(lines.some((l) => /2 turns failed/.test(l) && /net/.test(l)));
  });
});
