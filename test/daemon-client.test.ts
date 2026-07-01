import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { Agent } from "undici";
import { daemonDispatcher } from "../packages/cli/src/lib/daemon-client.js";

// A server that waits before sending any response headers, simulating a
// long-running daemon operation (e.g. upgrade running `npm install`).
function slowHeaderServer(delayMs: number): Promise<{ server: Server; url: string }> {
  return new Promise((res) => {
    const server = createServer((_req, response) => {
      setTimeout(() => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      }, delayMs);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      res({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

describe("daemonDispatcher", () => {
  let server: Server;
  let url: string;

  before(async () => {
    // Well beyond undici's coarse fast-timer granularity so the short-timeout
    // case below reliably fires before headers arrive.
    ({ server, url } = await slowHeaderServer(2500));
  });

  after(() => {
    server.close();
  });

  it("undici's short headers timeout aborts a slow response", async () => {
    const shortDispatcher = new Agent({ headersTimeout: 500, bodyTimeout: 500 });
    await assert.rejects(
      // @ts-expect-error dispatcher is a valid Node fetch option, absent from RequestInit
      () => fetch(url, { dispatcher: shortDispatcher }),
      (err: Error & { cause?: { code?: string } }) => err.cause?.code === "UND_ERR_HEADERS_TIMEOUT",
    );
    await shortDispatcher.close();
  });

  it("daemonDispatcher tolerates a response slower than a short timeout", async () => {
    // @ts-expect-error dispatcher is a valid Node fetch option, absent from RequestInit
    const res = await fetch(url, { dispatcher: daemonDispatcher });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});
