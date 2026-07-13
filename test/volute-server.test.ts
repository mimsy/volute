import assert from "node:assert/strict";
import type { AddressInfo, Server } from "node:net";
import { after, before, describe, it } from "node:test";
import type { Router } from "../templates/_base/src/lib/router.js";
import { createVoluteServer } from "../templates/_base/src/lib/volute-server.js";

// --- HTTP contract tests ---

function getUrl(server: Server): string {
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

describe("volute server HTTP contract", () => {
  let server: Server;
  const calls: {
    content: unknown;
    session?: string;
    channel?: string;
    sender?: string;
    isEvent?: boolean;
    eventLabel?: string;
    eventAt?: string;
  }[] = [];

  const mockRouter: Router = {
    route(content, meta) {
      calls.push({ content, channel: meta?.channel, sender: meta?.sender });
      return { messageId: `msg-${Date.now()}`, unsubscribe: () => {} };
    },
    dispatch(content, session, meta) {
      calls.push({
        content,
        session,
        channel: meta?.channel,
        sender: meta?.sender,
        isEvent: meta?.isEvent,
        eventLabel: meta?.eventLabel,
        eventAt: meta?.eventAt,
      });
      return { messageId: `msg-${Date.now()}`, unsubscribe: () => {} };
    },
    dispatchBatch() {},
    close() {},
  };

  before(() => {
    server = createVoluteServer({
      router: mockRouter,
      port: 0,
      name: "test-mind",
      version: "1.2.3",
    });
    return new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });
  });

  after(() => {
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("GET /health returns status, name, version", async () => {
    const res = await fetch(`${getUrl(server)}/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json");
    const body = await res.json();
    assert.deepEqual(body, { status: "ok", name: "test-mind", version: "1.2.3" });
  });

  it("POST /message returns ok immediately (fire-and-forget)", async () => {
    calls.length = 0;

    const res = await fetch(`${getUrl(server)}/message`, {
      method: "POST",
      body: JSON.stringify({
        content: [{ type: "text", text: "hi" }],
        channel: "web",
        sender: "alice",
      }),
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json");

    const body = await res.json();
    assert.deepEqual(body, { ok: true });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].content, [{ type: "text", text: "hi" }]);
    assert.equal(calls[0].channel, "web");
    assert.equal(calls[0].sender, "alice");
  });

  it("POST /message with kind:event dispatches with event framing and acks with a marker", async () => {
    calls.length = 0;

    const res = await fetch(`${getUrl(server)}/message`, {
      method: "POST",
      body: JSON.stringify({
        kind: "event",
        event: {
          id: 42,
          type: "schedule",
          label: "Schedule: morning-check",
          body: "Review the journal.",
          at: "2026-07-13 07:30:00",
        },
      }),
    });

    assert.equal(res.status, 200);
    // The `event: true` marker is how the daemon distinguishes an event-aware template
    // from a pre-events one that 200-acks after mangling the envelope.
    assert.deepEqual(await res.json(), { ok: true, event: true });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].content, [{ type: "text", text: "Review the journal." }]);
    assert.equal(calls[0].session, "main", "session defaults to main when the envelope omits it");
    assert.equal(calls[0].isEvent, true);
    assert.equal(calls[0].eventLabel, "Schedule: morning-check");
    assert.equal(calls[0].eventAt, "2026-07-13 07:30:00");
    // The unique event channel is echoed back on turn events for reflection attribution.
    assert.equal(calls[0].channel, "event:schedule:42");
    // No sender framing on events.
    assert.equal(calls[0].sender, undefined);
  });

  it("POST /message with kind:event honors an explicit session", async () => {
    calls.length = 0;
    const res = await fetch(`${getUrl(server)}/message`, {
      method: "POST",
      body: JSON.stringify({
        kind: "event",
        session: "night-watch",
        event: { id: 7, type: "webhook", label: "Webhook: deploy", body: "b", at: "" },
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(calls[0].session, "night-watch");
  });

  it("POST /message with invalid body returns 400", async () => {
    const res = await fetch(`${getUrl(server)}/message`, {
      method: "POST",
      body: "not json{{{",
    });
    assert.equal(res.status, 400);
  });

  it("GET /unknown returns 404", async () => {
    const res = await fetch(`${getUrl(server)}/unknown`);
    assert.equal(res.status, 404);
  });
});
