import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo, Server } from "node:net";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { findTemplatesDir } from "../src/lib/template.js";
import {
  createVoluteServer,
  type VoluteAgent,
} from "../templates/agent-sdk/src/lib/volute-server.js";

// --- File conformance ---

describe("volute-server conformance", () => {
  const agentSdkDir = findTemplatesDir("agent-sdk");
  const piDir = findTemplatesDir("pi");

  it("agent-sdk and pi volute-server.ts are identical", () => {
    const agentSdk = readFileSync(resolve(agentSdkDir, "src/lib/volute-server.ts"), "utf-8");
    const pi = readFileSync(resolve(piDir, "src/lib/volute-server.ts"), "utf-8");
    assert.equal(agentSdk, pi);
  });
});

// --- HTTP contract tests ---

function getUrl(server: Server): string {
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

describe("volute server HTTP contract", () => {
  let server: Server;
  const calls: { content: unknown; channel?: string; sender?: string }[] = [];

  const mockAgent: VoluteAgent = {
    sendMessage(content, channel, sender) {
      calls.push({ content, channel, sender });
    },
    onMessage(listener) {
      // Emit canned response asynchronously
      setTimeout(() => {
        listener({ type: "text", content: "hello" });
        listener({ type: "done" });
      }, 10);
      return () => {};
    },
  };

  before(() => {
    server = createVoluteServer({
      agent: mockAgent,
      port: 0,
      name: "test-agent",
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
    assert.deepEqual(body, { status: "ok", name: "test-agent", version: "1.2.3" });
  });

  it("POST /message streams NDJSON and passes content/channel/sender", async () => {
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
    assert.equal(res.headers.get("content-type"), "application/x-ndjson");

    const text = await res.text();
    const lines = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0], { type: "text", content: "hello" });
    assert.deepEqual(lines[1], { type: "done" });

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

describe("volute server client disconnect", () => {
  it("cleans up listener when client aborts", async () => {
    let listenerRemoved = false;

    const slowAgent: VoluteAgent = {
      sendMessage() {},
      onMessage(_listener) {
        // Never emit done — simulates a long-running request
        return () => {
          listenerRemoved = true;
        };
      },
    };

    const srv = createVoluteServer({
      agent: slowAgent,
      port: 0,
      name: "slow-agent",
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

    // Wait for the request to reach the server and listener to be registered
    await new Promise((r) => setTimeout(r, 100));

    // Destroy the connection from the client side
    req.destroy();

    // Give time for the close event to propagate to the server
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(listenerRemoved, "Expected listener to be removed after client disconnect");

    await new Promise<void>((resolve) => {
      srv.close(() => resolve());
    });
  });
});
