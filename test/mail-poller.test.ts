import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { formatEmailContent, MailPoller } from "../packages/daemon/src/lib/daemon/mail-poller.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { clearConfigCache } from "../packages/daemon/src/lib/delivery/delivery-router.js";
import { addMind, removeMind, setMindRunning } from "../packages/daemon/src/lib/mind/registry.js";
import { mindHistory } from "../packages/daemon/src/lib/schema.js";

describe("MailPoller", () => {
  it("start and stop manage state", () => {
    const poller = new MailPoller();
    // Without systems config, start does nothing
    poller.start();
    assert.equal(poller.isRunning(), false);
    poller.stop();
    assert.equal(poller.isRunning(), false);
  });

  it("stop is safe to call without start", () => {
    const poller = new MailPoller();
    poller.stop();
    assert.ok(true);
  });
});

describe("MailPoller catch-up watermark", () => {
  const SINCE = "2020-01-01T00:00:00.000Z";
  const OPEN = 1; // WebSocket.OPEN
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // Build a poller primed as if it just reconnected after a gap: configured,
  // with a pending watermark and an open socket ready to have it cleared.
  function primedPoller(): MailPoller {
    const poller = new MailPoller();
    const p = poller as unknown as {
      config: unknown;
      disconnectedAt: string | null;
      ws: unknown;
      catchUpAndClear(since: string): Promise<void>;
    };
    p.config = { apiKey: "k", system: "s", apiUrl: "http://systems.test" };
    p.disconnectedAt = SINCE;
    p.ws = { readyState: OPEN };
    return poller;
  }

  function watermark(poller: MailPoller): string | null {
    return (poller as unknown as { disconnectedAt: string | null }).disconnectedAt;
  }

  // A 200 response carrying the given missed-email ids, so catch-up actually
  // invokes deliver() for each one.
  function emailsResponse(...ids: string[]): Response {
    const emails = ids.map((id) => ({
      mind: "m",
      id,
      from: { address: "a@b.c", name: null },
      subject: null,
      body: "hi",
      html: null,
      receivedAt: SINCE,
    }));
    return new Response(JSON.stringify({ emails }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Swap the instance's deliver() for a stub; catchUp calls this.deliver, so an
  // instance property shadows the prototype method.
  function stubDeliver(
    poller: MailPoller,
    fn: (mind: string, email: { id: string }) => Promise<void>,
  ) {
    (poller as unknown as { deliver: typeof fn }).deliver = fn;
  }

  function catchUpAndClear(poller: MailPoller, since: string): Promise<void> {
    return (poller as unknown as { catchUpAndClear(s: string): Promise<void> }).catchUpAndClear(
      since,
    );
  }

  it("retains the watermark when the catch-up fetch throws", async () => {
    globalThis.fetch = async () => {
      throw new Error("network blip");
    };
    const poller = primedPoller();
    await (poller as unknown as { catchUpAndClear(s: string): Promise<void> }).catchUpAndClear(
      SINCE,
    );
    assert.equal(watermark(poller), SINCE, "failed catch-up must not drop the gap");
  });

  it("retains the watermark on a non-OK catch-up response", async () => {
    globalThis.fetch = async () => new Response("nope", { status: 503 });
    const poller = primedPoller();
    await (poller as unknown as { catchUpAndClear(s: string): Promise<void> }).catchUpAndClear(
      SINCE,
    );
    assert.equal(watermark(poller), SINCE);
  });

  it("clears the watermark exactly once after a successful catch-up", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ emails: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const poller = primedPoller();
    await (poller as unknown as { catchUpAndClear(s: string): Promise<void> }).catchUpAndClear(
      SINCE,
    );
    assert.equal(watermark(poller), null, "success must advance past the fetched gap");
    assert.equal(calls, 1);
  });

  it("does not clear if the socket dropped again during catch-up", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ emails: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const poller = primedPoller();
    // Simulate a re-disconnect mid-flight: the socket is no longer open.
    (poller as unknown as { ws: unknown }).ws = { readyState: 3 /* CLOSED */ };
    await (poller as unknown as { catchUpAndClear(s: string): Promise<void> }).catchUpAndClear(
      SINCE,
    );
    assert.equal(watermark(poller), SINCE, "a fresh gap must keep its watermark for retry");
  });

  it("delivers every missed email and clears the watermark on success", async () => {
    globalThis.fetch = async () => emailsResponse("a", "b");
    const poller = primedPoller();
    const delivered: string[] = [];
    stubDeliver(poller, async (_mind, email) => {
      delivered.push(email.id);
    });
    await catchUpAndClear(poller, SINCE);
    assert.deepEqual(delivered, ["a", "b"], "all missed emails must be delivered");
    assert.equal(watermark(poller), null);
  });

  it("retains the watermark when a delivery throws mid-catch-up", async () => {
    // This is the core loss-proofing guarantee: reintroducing a swallowed
    // try/catch in deliver() (the original #423 bug) would break this test.
    globalThis.fetch = async () => emailsResponse("a", "b");
    const poller = primedPoller();
    let attempts = 0;
    stubDeliver(poller, async () => {
      attempts++;
      throw new Error("delivery boom");
    });
    await catchUpAndClear(poller, SINCE);
    assert.equal(watermark(poller), SINCE, "a failed delivery must retain the gap");
    assert.equal(attempts, 1, "catch-up must stop at the first failed delivery");
  });

  it("does not clear if a newer disconnect advanced the watermark during catch-up", async () => {
    // Exercises the `disconnectedAt === since` clause of the clear-guard: the
    // socket stays open, but a re-disconnect moved the watermark forward, so the
    // fresh gap must not be cleared by the older catch-up.
    const NEWER = "2020-01-02T00:00:00.000Z";
    let poller!: MailPoller;
    globalThis.fetch = async () => {
      (poller as unknown as { disconnectedAt: string | null }).disconnectedAt = NEWER;
      return emailsResponse();
    };
    poller = primedPoller();
    await catchUpAndClear(poller, SINCE);
    assert.equal(watermark(poller), NEWER, "the fresher gap's watermark must survive");
  });
});

// These exercise the REAL deliver() (not a stub) so they pin the fix's premise:
// deliverMessage NEVER throws — it returns false on failure — so deliver() must
// convert that to a throw. No delivery manager is initialized in unit tests, so
// deliverMessage's routeAndDeliver fails and returns false.
describe("MailPoller.deliver — delivery-failure propagation", () => {
  const MIND = "test-mailpoller-deliver";
  const PORT = 41977;
  const email = {
    mind: MIND,
    id: "e1",
    from: { address: "sender@x.test", name: "Sender" },
    subject: "hi",
    body: "body",
    html: null,
    receivedAt: "2020-01-01T00:00:00.000Z",
  };

  const configDir = () => resolve(process.env.VOLUTE_HOME!, "minds", MIND, "home/.config");

  afterEach(async () => {
    const db = await getDb();
    await db.delete(mindHistory).where(eq(mindHistory.mind, MIND));
    await removeMind(MIND);
    rmSync(resolve(configDir(), "routes.json"), { force: true });
    clearConfigCache();
  });

  function deliver(mind: string): Promise<void> {
    return (
      new MailPoller() as unknown as { deliver(m: string, e: typeof email): Promise<void> }
    ).deliver(mind, email);
  }

  // Give the fixture the DM route every real mind gets from the default template. Mail is
  // delivered with `isDM: true`, so a real mind routes it (and never gates it); without a
  // routes.json the bare fixture would gate the unrouted `mail:` channel, and gated
  // messages are not recorded as inbound (#636/#420). Routing the DM keeps the inbound row
  // meaningful as proof that deliverMessage was reached.
  function routeDMs(): void {
    mkdirSync(configDir(), { recursive: true });
    // No `session` needed — matching the DM (so it isn't gated) is all this test requires.
    writeFileSync(
      resolve(configDir(), "routes.json"),
      JSON.stringify({ rules: [{ channel: "*", isDM: true }] }),
    );
    clearConfigCache(MIND);
  }

  it("throws when deliverMessage reports failure (Finding 1 — false is not success)", async () => {
    await addMind(MIND, PORT);
    await setMindRunning(MIND, true);
    // Reintroducing a swallowed try/catch or ignoring the boolean would resolve
    // here and let catch-up clear the watermark past undelivered mail.
    await assert.rejects(deliver(MIND), /delivery to .* failed/);
  });

  it("does not pre-skip a mind with running=false (Finding 2 — sleeping minds queue)", async () => {
    await addMind(MIND, PORT); // running defaults to false, as a sleeping mind is
    routeDMs(); // a real mind routes its DMs; mail arrives as a DM
    // The old `!entry.running` pre-check returned before deliverMessage, dropping
    // the mail and bypassing sleep-queueing. It must now reach deliverMessage,
    // which records the inbound (and, for a truly sleeping mind, queues it).
    await assert.rejects(deliver(MIND));
    const db = await getDb();
    const rows = await db
      .select()
      .from(mindHistory)
      .where(and(eq(mindHistory.mind, MIND), eq(mindHistory.type, "inbound")));
    assert.equal(rows.length, 1, "a running=false mind must not be skipped before deliverMessage");
  });

  it("deliberately drops (no throw) for a mind that no longer exists", async () => {
    // Not-found = deleted mind: no retry can help, so don't throw (that would pin
    // the watermark forever). Resolving without throwing is the assertion.
    await deliver("no-such-mailpoller-mind");
  });
});

describe("email formatting", () => {
  // The `From:` line is the only place a mind meets the sender's self-chosen name: the
  // delivered `sender` is the namespaced `mail:<address>` (#1016), never `from.name`.
  const FROM = { address: "alice@example.test", name: "Alice Smith" };
  const ANON = { address: "alice@example.test", name: null };

  it("formats email with subject and body", () => {
    const text = formatEmailContent({
      from: FROM,
      subject: "Hello",
      body: "How are you?",
      html: null,
    });
    assert.equal(text, "From: Alice Smith <alice@example.test>\nSubject: Hello\n\nHow are you?");
  });

  it("formats body-only email", () => {
    const text = formatEmailContent({ from: FROM, subject: null, body: "Just a body", html: null });
    assert.equal(text, "From: Alice Smith <alice@example.test>\n\nJust a body");
  });

  it("falls back to the bare address when the sender set no name", () => {
    const text = formatEmailContent({ from: ANON, subject: null, body: "Just a body", html: null });
    assert.equal(text, "From: alice@example.test\n\nJust a body");
  });

  it("formats HTML-only email with subject", () => {
    const text = formatEmailContent({
      from: ANON,
      subject: "Newsletter",
      body: null,
      html: "<p>content</p>",
    });
    assert.equal(
      text,
      "From: alice@example.test\nSubject: Newsletter\n\n[HTML email — plain text not available]",
    );
  });

  it("formats HTML-only email without subject", () => {
    const text = formatEmailContent({
      from: ANON,
      subject: null,
      body: null,
      html: "<p>content</p>",
    });
    assert.equal(text, "From: alice@example.test\n\n[HTML email — plain text not available]");
  });

  it("formats a mail with no body at all", () => {
    const text = formatEmailContent({ from: ANON, subject: null, body: null, html: null });
    assert.equal(text, "From: alice@example.test\n\n[No message body]");
  });

  it("formats subject-only email", () => {
    const text = formatEmailContent({
      from: ANON,
      subject: "Subject only",
      body: null,
      html: null,
    });
    assert.equal(text, "From: alice@example.test\nSubject: Subject only\n\n[No message body]");
  });
});
