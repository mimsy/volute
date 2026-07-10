import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eq } from "drizzle-orm";
import {
  clearDeliveredNotices,
  drainNotices,
  formatNotices,
  hasUndeliveredNotice,
  latestFailureNotice,
  latestNotice,
  MIND_LEVEL_SESSION,
  type Notice,
  recordNotice,
} from "../packages/daemon/src/lib/daemon/notices.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { turns } from "../packages/daemon/src/lib/schema.js";

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

describe("latestFailureNotice", () => {
  it("returns null when the mind has no notices", async () => {
    assert.equal(await latestFailureNotice(uniqueMind()), null);
  });

  it("returns the newest failure across sessions", async () => {
    const mind = uniqueMind();
    await recordNotice({
      mind,
      session: "main",
      kind: "turn_error",
      reason: "network",
      detail: "older",
    });
    await recordNotice({
      mind,
      session: "other",
      kind: "crash",
      reason: "process_crash",
      detail: "newer",
    });

    const failure = await latestFailureNotice(mind);
    assert.equal(failure?.kind, "crash");
    assert.equal(failure?.reason, "process_crash");
    assert.equal(failure?.detail, "newer");
    assert.ok(failure?.at, "should carry the notice timestamp");
  });

  it("ignores budget and extension notices", async () => {
    const mind = uniqueMind();
    await recordNotice({
      mind,
      session: "main",
      kind: "turn_error",
      reason: "auth_error",
      detail: "the failure",
    });
    await recordNotice({
      mind,
      session: "main",
      kind: "budget",
      reason: "token_budget",
      detail: "budget pause",
    });
    await recordNotice({
      mind,
      session: "",
      kind: "extension",
      reason: "notes",
      detail: "someone commented",
    });

    const failure = await latestFailureNotice(mind);
    assert.equal(failure?.detail, "the failure");

    const budgetOnly = uniqueMind();
    await recordNotice({
      mind: budgetOnly,
      session: "main",
      kind: "budget",
      reason: "token_budget",
      detail: "budget pause",
    });
    assert.equal(await latestFailureNotice(budgetOnly), null);
  });

  it("clears once delivered notices are deleted (recovery on a clean turn)", async () => {
    const mind = uniqueMind();
    await recordNotice({
      mind,
      session: "main",
      kind: "turn_error",
      reason: "overloaded",
      detail: "a 529",
    });
    assert.ok(await latestFailureNotice(mind));

    const drained = await drainNotices(mind, "main");
    await clearDeliveredNotices(mind, "main", Math.max(...drained.map((n) => n.id)));
    assert.equal(await latestFailureNotice(mind), null);
  });

  it("clears when another session completes a turn after the failure (cross-session recovery)", async () => {
    // A failure in a session that never runs again must not pin the status
    // bar forever: any turn completed after the notice counts as recovery.
    const mind = uniqueMind();
    await recordNotice({
      mind,
      session: "quiet-channel",
      kind: "crash",
      reason: "process_crash",
      detail: "crashed",
    });
    assert.ok(await latestFailureNotice(mind));

    const db = await getDb();
    await db.insert(turns).values({
      id: `${mind}-turn-1`,
      mind,
      session: "main",
      status: "complete",
      created_at: "2999-01-01 00:00:00",
    });
    try {
      assert.equal(await latestFailureNotice(mind), null);
    } finally {
      await db.delete(turns).where(eq(turns.mind, mind));
    }
  });

  it("a turn completed before the failure does not count as recovery", async () => {
    const mind = uniqueMind();
    const db = await getDb();
    await db.insert(turns).values({
      id: `${mind}-turn-0`,
      mind,
      session: "main",
      status: "complete",
      created_at: "2000-01-01 00:00:00",
    });
    try {
      await recordNotice({
        mind,
        session: "main",
        kind: "turn_error",
        reason: "network",
        detail: "still broken",
      });
      const failure = await latestFailureNotice(mind);
      assert.equal(failure?.detail, "still broken");
    } finally {
      await db.delete(turns).where(eq(turns.mind, mind));
    }
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

  it("latestNotice returns the newest un-drained notice across sessions", async () => {
    const mind = uniqueMind();
    assert.equal(await latestNotice(mind), null);
    await recordNotice({
      mind,
      session: "main",
      kind: "turn_error",
      reason: "auth_error",
      detail: "older",
    });
    await recordNotice({
      mind,
      session: MIND_LEVEL_SESSION,
      kind: "startup",
      reason: "no_credentials",
      detail: "newest",
    });
    const latest = await latestNotice(mind);
    assert.equal(latest?.detail, "newest");
    assert.equal(latest?.reason, "no_credentials");
  });

  it("hasUndeliveredNotice detects (and dedupes) a reason for a mind", async () => {
    const mind = uniqueMind();
    assert.equal(await hasUndeliveredNotice(mind, "no_credentials"), false);
    await recordNotice({
      mind,
      session: MIND_LEVEL_SESSION,
      kind: "startup",
      reason: "no_credentials",
      detail: "mute",
    });
    assert.equal(await hasUndeliveredNotice(mind, "no_credentials"), true);
    // A different reason is not matched.
    assert.equal(await hasUndeliveredNotice(mind, "process_crash"), false);
  });
});
