import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { after, before, describe, it } from "node:test";

// The template daemon-client reads its env at module load, so the stub daemon and
// env vars must exist before the dynamic import below.

type Recorded = { method: string; url: string; auth?: string; body: unknown };

let server: Server;
let received: Recorded[];
let daemonNotice: (input: { kind: string; message: string; thread?: string }) => Promise<void>;

describe("template daemonNotice", () => {
  before(async () => {
    received = [];
    server = createServer((req: IncomingMessage, res) => {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
      });
      req.on("end", () => {
        received.push({
          method: req.method ?? "",
          url: req.url ?? "",
          auth: req.headers.authorization,
          body: raw ? JSON.parse(raw) : undefined,
        });
        res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
      });
    });
    const port: number = await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    process.env.VOLUTE_DAEMON_PORT = String(port);
    process.env.VOLUTE_MIND = "tpl-mind";
    process.env.VOLUTE_MIND_TOKEN = "tpl-token";
    ({ daemonNotice } = await import("../templates/_base/src/lib/daemon-client.js"));
  });

  after(() => {
    server.close();
  });

  it("POSTs the notice to the mind's own notices endpoint with its token", async () => {
    await daemonNotice({ kind: "context_lost", message: "session gone", thread: "main" });

    assert.equal(received.length, 1);
    const req = received[0];
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/api/minds/tpl-mind/notices");
    assert.equal(req.auth, "Bearer tpl-token");
    assert.deepEqual(req.body, { kind: "context_lost", message: "session gone", thread: "main" });
  });

  it("omits thread when not given (mind-level notice)", async () => {
    received.length = 0;
    await daemonNotice({ kind: "context_lost", message: "compaction failed" });

    assert.equal(received.length, 1);
    assert.deepEqual(received[0].body, { kind: "context_lost", message: "compaction failed" });
  });
});
