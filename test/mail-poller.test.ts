import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { formatEmailContent, MailPoller } from "../packages/daemon/src/lib/daemon/mail-poller.js";

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
});

describe("email formatting", () => {
  it("formats email with subject and body", () => {
    const text = formatEmailContent({ subject: "Hello", body: "How are you?", html: null });
    assert.equal(text, "Subject: Hello\n\nHow are you?");
  });

  it("formats body-only email", () => {
    const text = formatEmailContent({ subject: null, body: "Just a body", html: null });
    assert.equal(text, "Just a body");
  });

  it("formats HTML-only email with subject", () => {
    const text = formatEmailContent({ subject: "Newsletter", body: null, html: "<p>content</p>" });
    assert.equal(text, "Subject: Newsletter\n\n[HTML email — plain text not available]");
  });

  it("formats HTML-only email without subject", () => {
    const text = formatEmailContent({ subject: null, body: null, html: "<p>content</p>" });
    assert.equal(text, "[HTML email — plain text not available]");
  });

  it("formats empty email", () => {
    const text = formatEmailContent({ subject: null, body: null, html: null });
    assert.equal(text, "[Empty email]");
  });

  it("formats subject-only email", () => {
    const text = formatEmailContent({ subject: "Subject only", body: null, html: null });
    assert.equal(text, "Subject: Subject only");
  });
});
