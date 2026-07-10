import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { Agent } from "undici";
import { daemonDispatcher, resolveWebUrl } from "../packages/cli/src/lib/daemon-client.js";

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

describe("resolveWebUrl", () => {
  const systemDir = resolve(process.env.VOLUTE_HOME!, "system");
  const configPath = resolve(systemDir, "daemon.json");

  function writeDaemonConfig(config: Record<string, unknown>) {
    mkdirSync(systemDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(config));
  }

  afterEach(() => {
    rmSync(configPath, { force: true });
    delete process.env.VOLUTE_DAEMON_URL;
  });

  it("builds an http URL from the public port and hostname", () => {
    writeDaemonConfig({ port: 1618, hostname: "0.0.0.0" });
    assert.equal(resolveWebUrl(), "http://localhost:1618");
  });

  it("uses https and the public port when TLS is enabled", () => {
    // With TLS, CLI traffic goes to internalPort, but the browser-facing URL
    // must stay on the public https port.
    writeDaemonConfig({ port: 1618, internalPort: 1619, hostname: "myhost.ts.net", tls: true });
    assert.equal(resolveWebUrl(), "https://myhost.ts.net:1618");
  });

  it("prefers VOLUTE_DAEMON_URL when set", () => {
    process.env.VOLUTE_DAEMON_URL = "https://remote.example:8443";
    assert.equal(resolveWebUrl(), "https://remote.example:8443");
  });
});
