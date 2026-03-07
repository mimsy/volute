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
  const calls: { content: unknown; channel?: string; sender?: string }[] = [];

  const mockRouter: Router = {
    route(content, meta) {
      calls.push({ content, channel: meta?.channel, sender: meta?.sender });
      return { messageId: `msg-${Date.now()}`, unsubscribe: () => {} };
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
