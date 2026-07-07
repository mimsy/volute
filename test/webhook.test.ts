import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, beforeEach, describe, it } from "node:test";
import { broadcast } from "../packages/daemon/src/lib/events/activity-events.js";
import { fireWebhook, initWebhook } from "../packages/daemon/src/lib/webhook.js";

type Received = {
  method: string;
  body: string;
  contentType: string | undefined;
  authorization: string | undefined;
};

type TestServer = {
  server: Server;
  port: number;
  received: Received[];
  /** Resolves once the next request has been fully received. */
  nextRequest: () => Promise<void>;
  setStatusCode: (code: number) => void;
};

// Each test gets its own server + received array so an in-flight POST from a
// previous test can never leak into another test's assertions.
async function startServer(): Promise<TestServer> {
  const received: Received[] = [];
  let statusCode = 200;
  let pending: (() => void) | undefined;

  const server = createServer((req: IncomingMessage, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      received.push({
        method: req.method!,
        body,
        contentType: req.headers["content-type"],
        authorization: req.headers.authorization,
      });
      res.writeHead(statusCode);
      res.end();
      pending?.();
      pending = undefined;
    });
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, () => {
      resolve((server.address() as { port: number }).port);
    });
  });

  return {
    server,
    port,
    received,
    nextRequest: () =>
      new Promise<void>((resolve) => {
        pending = resolve;
      }),
    setStatusCode: (code) => {
      statusCode = code;
    },
  };
}

describe("webhook", () => {
  let ts: TestServer;

  beforeEach(async () => {
    delete process.env.VOLUTE_WEBHOOK_URL;
    delete process.env.VOLUTE_WEBHOOK_SECRET;
    ts = await startServer();
  });

  afterEach(async () => {
    delete process.env.VOLUTE_WEBHOOK_URL;
    delete process.env.VOLUTE_WEBHOOK_SECRET;
    await new Promise<void>((resolve) => ts.server.close(() => resolve()));
  });

  it("sends POST with event data when webhook URL is set", async () => {
    process.env.VOLUTE_WEBHOOK_URL = `http://127.0.0.1:${ts.port}`;
    await fireWebhook({
      event: "schedule_changed",
      mind: "test-mind",
      data: {
        schedules: [
          { id: "daily-check", cron: "0 9 * * *", message: "good morning", enabled: true },
        ],
      },
      timestamp: "2026-01-01T00:00:00Z",
    });

    assert.equal(ts.received.length, 1);
    assert.equal(ts.received[0].method, "POST");
    assert.equal(ts.received[0].contentType, "application/json");
    const payload = JSON.parse(ts.received[0].body);
    assert.equal(payload.event, "schedule_changed");
    assert.equal(payload.mind, "test-mind");
    assert.equal(payload.timestamp, "2026-01-01T00:00:00Z");
    assert.deepEqual(payload.data.schedules, [
      { id: "daily-check", cron: "0 9 * * *", message: "good morning", enabled: true },
    ]);
  });

  it("does nothing when webhook URL is not set", async () => {
    await fireWebhook({ event: "mind_started", mind: "test", data: {}, timestamp: "" });
    assert.equal(ts.received.length, 0);
  });

  it("includes Authorization header when VOLUTE_WEBHOOK_SECRET is set", async () => {
    process.env.VOLUTE_WEBHOOK_URL = `http://127.0.0.1:${ts.port}`;
    process.env.VOLUTE_WEBHOOK_SECRET = "test-secret-token";
    await fireWebhook({ event: "mind_started", mind: "test", data: {}, timestamp: "" });

    assert.equal(ts.received.length, 1);
    assert.equal(ts.received[0].authorization, "Bearer test-secret-token");
  });

  it("omits Authorization header when VOLUTE_WEBHOOK_SECRET is not set", async () => {
    process.env.VOLUTE_WEBHOOK_URL = `http://127.0.0.1:${ts.port}`;
    await fireWebhook({ event: "mind_stopped", mind: "test", data: {}, timestamp: "" });

    assert.equal(ts.received.length, 1);
    assert.equal(ts.received[0].authorization, undefined);
  });

  it("does not throw on non-2xx response", async () => {
    process.env.VOLUTE_WEBHOOK_URL = `http://127.0.0.1:${ts.port}`;
    ts.setStatusCode(500);
    await fireWebhook({ event: "mind_started", mind: "test", data: {}, timestamp: "" });

    assert.equal(ts.received.length, 1);
  });

  it("does not throw when webhook URL is unreachable", async () => {
    process.env.VOLUTE_WEBHOOK_URL = "http://127.0.0.1:1";
    await fireWebhook({ event: "mind_started", mind: "test", data: {}, timestamp: "" });
    assert.ok(true);
  });

  it("initWebhook returns no-op when URL is not set", () => {
    const unsub = initWebhook();
    assert.equal(typeof unsub, "function");
    unsub(); // should not throw
  });

  it("initWebhook returns no-op for invalid URL", () => {
    process.env.VOLUTE_WEBHOOK_URL = "not-a-url";
    const unsub = initWebhook();
    assert.equal(typeof unsub, "function");
    unsub();
  });

  it("initWebhook forwards activity events to webhook", async () => {
    process.env.VOLUTE_WEBHOOK_URL = `http://127.0.0.1:${ts.port}`;
    const unsub = initWebhook();

    // The subscribe callback fires the webhook fire-and-forget, so wait on the
    // server receiving the request rather than a timer.
    const delivered = ts.nextRequest();
    broadcast({
      type: "mind_started",
      mind: "test-mind",
      summary: "Mind started",
      metadata: { port: 4100 },
    });
    await delivered;

    unsub();

    assert.equal(ts.received.length, 1);
    const payload = JSON.parse(ts.received[0].body);
    assert.equal(payload.event, "mind_started");
    assert.equal(payload.mind, "test-mind");
    assert.equal(payload.data.summary, "Mind started");
    assert.equal(payload.data.port, 4100);
    assert.ok(payload.timestamp);
  });
});
