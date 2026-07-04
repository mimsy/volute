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

  it("mind-level notices (session '') drain into any session and clear by watermark", async () => {
    const mind = uniqueMind();
    // A session-scoped notice and a mind-level (extension) notice.
    await recordNotice({
      mind,
      session: "main",
      kind: "turn_error",
      reason: "unknown",
      detail: "session-scoped",
    });
    await recordNotice({
      mind,
      session: "",
      kind: "extension",
      reason: "notes",
      detail: "pip commented on your note",
    });

    // Draining "main" picks up both (mind-level included), oldest first.
    const drained = await drainNotices(mind, "main");
    assert.deepEqual(
      drained.map((n) => n.detail),
      ["session-scoped", "pip commented on your note"],
    );

    // A clean turn clears both by watermark — the "" row must not redeliver.
    await clearDeliveredNotices(mind, "main", Math.max(...drained.map((n) => n.id)));
    assert.deepEqual(await drainNotices(mind, "main"), []);
    assert.deepEqual(await drainNotices(mind, "other"), []);
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
  // Mirror formatNotices' UTC→local rendering so assertions hold in any timezone.
  const localHM = (utc: string) =>
    new Date(`${utc.replace(" ", "T")}Z`).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
    });

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

  it("groups same-reason failures with a count and local time span", () => {
    const notices = [
      { ...base, id: 1, reason: "network", detail: "net", created_at: at("14:02") },
      { ...base, id: 2, reason: "network", detail: "net", created_at: at("14:31") },
    ] as Notice[];
    const out = formatNotices(notices)!;
    assert.equal(out.split("\n").filter((l) => l.startsWith("- ")).length, 1);
    assert.ok(
      out.includes(`2 turns failed (${localHM(at("14:02"))}–${localHM(at("14:31"))}): net`),
    );
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

  it("renders extension notices verbatim under a per-extension header", () => {
    const notices = [
      {
        ...base,
        id: 1,
        kind: "extension",
        reason: "notes",
        detail: "pip commented on whorl/one-macaroni",
        created_at: at("14:02"),
      },
      {
        ...base,
        id: 2,
        kind: "extension",
        reason: "notes",
        detail: "pip reacted 🌱 to whorl/calendar",
        created_at: at("15:10"),
      },
    ] as Notice[];
    const out = formatNotices(notices)!;
    assert.match(out, /\[Notes\]/);
    assert.match(out, /pip commented on whorl\/one-macaroni/);
    assert.match(out, /pip reacted 🌱/);
    // No "turns failed" framing for extension notices.
    assert.ok(!/turn failed/.test(out));
  });

  it("keeps failure and extension notices in separate blocks", () => {
    const notices = [
      { ...base, id: 1, reason: "auth_error", detail: "creds", created_at: at("14:02") },
      {
        ...base,
        id: 2,
        kind: "extension",
        reason: "notes",
        detail: "someone commented",
        created_at: at("14:05"),
      },
    ] as Notice[];
    const out = formatNotices(notices)!;
    assert.match(out, /turn failed/);
    assert.match(out, /\[Notes\]/);
    // The failure header precedes the extension block.
    assert.ok(out.indexOf("[Notices]") < out.indexOf("[Notes]"));
  });
});
