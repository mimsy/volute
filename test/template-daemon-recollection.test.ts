import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { after, before, describe, it } from "node:test";

// The template daemon-client reads its env at module load, so the stub daemon and
// env vars must exist before the dynamic import below.

let server: Server;
let requests: { url: string; auth?: string }[];
let reply: (res: import("node:http").ServerResponse) => void;
let daemonRecollection: (
  query: { before: string; tailStartedAt?: string },
  timeoutMs?: number,
) => Promise<unknown[]>;

describe("template daemonRecollection", () => {
  before(async () => {
    requests = [];
    server = createServer((req: IncomingMessage, res) => {
      requests.push({ url: req.url ?? "", auth: req.headers.authorization });
      reply(res);
    });
    const port: number = await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    process.env.VOLUTE_DAEMON_PORT = String(port);
    process.env.VOLUTE_MIND = "tpl-mind";
    process.env.VOLUTE_MIND_TOKEN = "tpl-token";
    ({ daemonRecollection } = await import("../templates/_base/src/lib/daemon-client.js"));
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  it("GETs the mind's own recollection with its token and returns the entries", async () => {
    const entries = [{ period: "day", period_key: "2026-09-22", content: "x" }];
    reply = (res) => res.writeHead(200).end(JSON.stringify({ entries }));
    const got = await daemonRecollection({
      before: "2026-09-23T11:30:00.000Z",
      tailStartedAt: "2026-09-23T10:00:00.000Z",
    });
    assert.deepEqual(got, entries);
    const req = requests.at(-1);
    assert.equal(
      req?.url,
      "/api/v1/minds/tpl-mind/history/recollection?before=2026-09-23T11%3A30%3A00.000Z&tailStartedAt=2026-09-23T10%3A00%3A00.000Z",
    );
    assert.equal(req?.auth, "Bearer tpl-token");
  });

  it("throws on an error status or a body without entries", async () => {
    reply = (res) => res.writeHead(404).end("{}");
    await assert.rejects(() => daemonRecollection({ before: "2026-09-23T11:30:00.000Z" }));
    reply = (res) => res.writeHead(200).end("{}");
    await assert.rejects(() => daemonRecollection({ before: "2026-09-23T11:30:00.000Z" }));
  });

  it("gives up at its timeout instead of holding the seam open", async () => {
    reply = () => {}; // never answers
    const started = Date.now();
    await assert.rejects(() => daemonRecollection({ before: "2026-09-23T11:30:00.000Z" }, 100));
    assert.ok(Date.now() - started < 2000);
  });
});
