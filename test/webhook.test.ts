import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { fireWebhook } from "../src/lib/webhook.js";

describe("webhook", () => {
  let server: Server;
  let port: number;
  let received: {
    method: string;
    body: string;
    contentType: string | undefined;
    authorization: string | undefined;
  }[];

  before(async () => {
    received = [];
    server = createServer((req: IncomingMessage, res) => {
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
        res.writeHead(200);
        res.end();
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });
  });

  after(() => {
    delete process.env.VOLUTE_WEBHOOK_URL;
    delete process.env.VOLUTE_DAEMON_TOKEN;
    server.close();
  });

  it("sends POST with event data when webhook URL is set", async () => {
    process.env.VOLUTE_WEBHOOK_URL = `http://127.0.0.1:${port}`;
    fireWebhook({
      event: "schedule_changed",
      mind: "test-mind",
      data: {
        schedules: [
          { id: "daily-check", cron: "0 9 * * *", message: "good morning", enabled: true },
        ],
      },
      timestamp: "2026-01-01T00:00:00Z",
    });

    await new Promise((r) => setTimeout(r, 200));

    assert.equal(received.length, 1);
    assert.equal(received[0].method, "POST");
    assert.equal(received[0].contentType, "application/json");
    const payload = JSON.parse(received[0].body);
    assert.equal(payload.event, "schedule_changed");
    assert.equal(payload.mind, "test-mind");
    assert.equal(payload.timestamp, "2026-01-01T00:00:00Z");
    assert.deepEqual(payload.data.schedules, [
      { id: "daily-check", cron: "0 9 * * *", message: "good morning", enabled: true },
    ]);
  });

  it("does nothing when webhook URL is not set", async () => {
    delete process.env.VOLUTE_WEBHOOK_URL;
    received = [];
    fireWebhook({ event: "mind_started", mind: "test", data: {}, timestamp: "" });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(received.length, 0);
  });

  it("includes Authorization header when VOLUTE_DAEMON_TOKEN is set", async () => {
    process.env.VOLUTE_WEBHOOK_URL = `http://127.0.0.1:${port}`;
    process.env.VOLUTE_DAEMON_TOKEN = "test-secret-token";
    received = [];
    fireWebhook({ event: "mind_started", mind: "test", data: {}, timestamp: "" });
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(received.length, 1);
    assert.equal(received[0].authorization, "Bearer test-secret-token");
    delete process.env.VOLUTE_DAEMON_TOKEN;
  });

  it("omits Authorization header when VOLUTE_DAEMON_TOKEN is not set", async () => {
    process.env.VOLUTE_WEBHOOK_URL = `http://127.0.0.1:${port}`;
    delete process.env.VOLUTE_DAEMON_TOKEN;
    received = [];
    fireWebhook({ event: "mind_stopped", mind: "test", data: {}, timestamp: "" });
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(received.length, 1);
    assert.equal(received[0].authorization, undefined);
  });

  it("forwards activity events with consistent format", async () => {
    process.env.VOLUTE_WEBHOOK_URL = `http://127.0.0.1:${port}`;
    received = [];
    fireWebhook({
      event: "mind_active",
      mind: "my-mind",
      data: { summary: "Processing message", session: "main" },
      timestamp: "2026-01-01T12:00:00Z",
    });
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(received.length, 1);
    const payload = JSON.parse(received[0].body);
    assert.equal(payload.event, "mind_active");
    assert.equal(payload.mind, "my-mind");
    assert.equal(payload.data.summary, "Processing message");
    assert.equal(payload.data.session, "main");
    assert.equal(payload.timestamp, "2026-01-01T12:00:00Z");
  });

  it("swallows errors when webhook URL is unreachable", async () => {
    process.env.VOLUTE_WEBHOOK_URL = "http://127.0.0.1:1";
    // Should not throw
    fireWebhook({ event: "mind_started", mind: "test", data: {}, timestamp: "" });
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(true);
  });
});
