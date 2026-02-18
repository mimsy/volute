import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import type { AddressInfo, Server } from "node:net";
import { after, before, describe, it } from "node:test";
import type { Router } from "../templates/_base/src/lib/router.js";
import type { Listener } from "../templates/_base/src/lib/types.js";
import { createVoluteServer } from "../templates/_base/src/lib/volute-server.js";

// --- HTTP contract tests ---

function getUrl(server: Server): string {
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

describe("volute server HTTP contract", () => {
  let server: Server;
  const calls: { content: unknown; channel?: string; sender?: string }[] = [];

  const mockRouter: Router = {
    route(content, meta, listener) {
      calls.push({ content, channel: meta?.channel, sender: meta?.sender });
      const messageId = `msg-${Date.now()}`;
      // Emit canned response asynchronously
      setTimeout(() => {
        listener?.({ type: "usage", input_tokens: 10, output_tokens: 5, messageId });
        listener?.({ type: "done", messageId });
      }, 10);
      return { messageId, unsubscribe: () => {} };
    },
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

  it("POST /message returns JSON with ok and usage", async () => {
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
    assert.equal(body.ok, true);
    assert.deepEqual(body.usage, { input_tokens: 10, output_tokens: 5 });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].content, [{ type: "text", text: "hi" }]);
    assert.equal(calls[0].channel, "web");
    assert.equal(calls[0].sender, "alice");
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

describe("volute server mid-turn interrupt", () => {
  it("first message gets response when second message arrives", async () => {
    let currentListener: Listener | undefined;
    let currentMessageId: string | undefined;
    let firstDoneFired = false;

    const interruptRouter: Router = {
      route(_content, _meta, listener) {
        const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        // If mid-turn, emit done for previous message
        if (currentListener && currentMessageId) {
          firstDoneFired = true;
          currentListener({ type: "done", messageId: currentMessageId });
        }

        currentListener = listener;
        currentMessageId = messageId;

        // Emit response after a delay (simulates agent processing)
        setTimeout(() => {
          if (currentMessageId === messageId) {
            listener?.({ type: "done", messageId });
            currentListener = undefined;
            currentMessageId = undefined;
          }
        }, 200);

        return { messageId, unsubscribe: () => {} };
      },
      close() {},
    };

    const srv = createVoluteServer({
      router: interruptRouter,
      port: 0,
      name: "interrupt-mind",
      version: "0.0.1",
    });

    await new Promise<void>((resolve) => srv.listen(0, () => resolve()));
    const url = getUrl(srv);

    // Send first message (don't await — it will be interrupted)
    const first = fetch(`${url}/message`, {
      method: "POST",
      body: JSON.stringify({ content: [{ type: "text", text: "msg1" }], channel: "web" }),
    });

    // Send second message quickly (before first completes)
    await new Promise((r) => setTimeout(r, 20));
    const second = fetch(`${url}/message`, {
      method: "POST",
      body: JSON.stringify({ content: [{ type: "text", text: "msg2" }], channel: "web" }),
    });

    // First message should get a JSON {ok: true} response (interrupted)
    const firstRes = await first;
    assert.equal(firstRes.status, 200);
    const firstBody = await firstRes.json();
    assert.equal(firstBody.ok, true);

    // Second message should also get a JSON {ok: true} response
    const secondRes = await second;
    assert.equal(secondRes.status, 200);
    const secondBody = await secondRes.json();
    assert.equal(secondBody.ok, true);

    assert.ok(firstDoneFired, "First listener should have received done (interrupt occurred)");

    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });
});

describe("volute server client disconnect", () => {
  it("cleans up when client aborts", async () => {
    let unsubscribeCalled = false;

    const slowRouter: Router = {
      route(_content, _meta, _listener) {
        // Never emit done — simulates a long-running request
        return {
          messageId: "msg-slow",
          unsubscribe: () => {
            unsubscribeCalled = true;
          },
        };
      },
      close() {},
    };

    const srv = createVoluteServer({
      router: slowRouter,
      port: 0,
      name: "slow-mind",
      version: "0.0.1",
    });

    await new Promise<void>((resolve) => {
      srv.listen(0, () => resolve());
    });

    const addr = srv.address() as AddressInfo;
    const body = JSON.stringify({ content: [{ type: "text", text: "hi" }] });

    // Use http.request so we can destroy the socket directly
    const req = httpRequest({
      hostname: "127.0.0.1",
      port: addr.port,
      path: "/message",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    });
    req.on("error", () => {}); // Ignore client-side errors from destroy
    req.end(body);

    // Wait for the request to reach the server
    await new Promise((r) => setTimeout(r, 100));

    // Destroy the connection from the client side
    req.destroy();

    // Give time for the close event to propagate to the server
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(unsubscribeCalled, "Expected unsubscribe to be called after client disconnect");

    await new Promise<void>((resolve) => {
      srv.close(() => resolve());
    });
  });
});

describe("volute server response without usage", () => {
  let server: Server;

  const noUsageRouter: Router = {
    route(_content, _meta, listener) {
      const messageId = `msg-${Date.now()}`;
      setTimeout(() => {
        listener?.({ type: "done", messageId });
      }, 10);
      return { messageId, unsubscribe: () => {} };
    },
    close() {},
  };

  before(() => {
    server = createVoluteServer({
      router: noUsageRouter,
      port: 0,
      name: "no-usage-mind",
      version: "1.0.0",
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

  it("returns ok with no usage key when router emits only done", async () => {
    const res = await fetch(`${getUrl(server)}/message`, {
      method: "POST",
      body: JSON.stringify({
        content: [{ type: "text", text: "hi" }],
        channel: "web",
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true });
  });
});
