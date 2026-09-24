import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, afterEach, before, describe, it, mock } from "node:test";
import { run } from "../packages/cli/src/commands/mind-status.js";
import type { MindEntry } from "../packages/daemon/src/lib/mind/registry.js";
import { toPublicMind } from "../packages/daemon/src/web/api/minds.js";

/**
 * #1146: a mind running `volute mind status` on itself printed `Port:    undefined`.
 * The daemon withholds `port` from every non-admin caller on purpose (#503), so the
 * CLI must print the line only when the daemon sent one.
 */

const entry: MindEntry = {
  name: "lyra",
  port: 4123,
  created: "2026-09-01 00:00:00",
  running: true,
  stage: "sprouted",
  mindType: "mind",
};

const status: Parameters<typeof toPublicMind>[1] = {
  status: "running",
  wakeAt: null,
  lastError: null,
  memory: null,
  channels: [{ name: "volute", displayName: "Volute", status: "connected" }],
  displayName: undefined,
  description: undefined,
  avatar: undefined,
  seedChecklist: undefined,
};

/** The body GET /api/v1/minds/lyra answers with, per test. */
let served: unknown;
let server: Server;
let savedUrl: string | undefined;

async function statusOutput(): Promise<string> {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  try {
    await run(["lyra"]);
  } finally {
    console.log = origLog;
  }
  return logs.join("\n");
}

describe("volute mind status port line (#1146)", () => {
  before(async () => {
    server = createServer((req, res) => {
      const path = (req.url ?? "").split("?")[0];
      if (path === "/api/v1/minds/lyra") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(served));
        return;
      }
      // /memory and /delivery/pending are optional extras; decline them.
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    savedUrl = process.env.VOLUTE_DAEMON_URL;
    process.env.VOLUTE_DAEMON_URL = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  after(async () => {
    if (savedUrl === undefined) delete process.env.VOLUTE_DAEMON_URL;
    else process.env.VOLUTE_DAEMON_URL = savedUrl;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => mock.restoreAll());

  it("omits the port line for the redacted view a mind gets of itself", async () => {
    served = toPublicMind(entry, status, { hasPages: false });
    assert.equal("port" in (served as object), false, "public view must stay port-free");

    const out = await statusOutput();
    assert.match(out, /Mind: {4}lyra/);
    assert.match(out, /Status: {2}running/);
    assert.doesNotMatch(out, /Port:/);
    assert.doesNotMatch(out, /undefined/);
    assert.match(out, /Volute: connected/);
  });

  it("prints the port when an admin caller receives it", async () => {
    served = { ...entry, ...status, variants: [], hasPages: false };
    const out = await statusOutput();
    assert.match(out, /Port: {4}4123/);
  });
});
