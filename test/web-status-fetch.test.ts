import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { fetchMe } from "../packages/web/src/ui/lib/auth.js";
import { fetchSetupStatus } from "../packages/web/src/ui/lib/setup-status.js";

// #724: the browser's setup and auth probes used to answer every failure with a
// routing-relevant default — "setup is complete", "not authenticated" — so a
// flaky proxy dead-ended the user at a login screen. Only the two statuses that
// genuinely carry that meaning (404 for a pre-wizard daemon, 401 for no session)
// may still produce one.

const realFetch = globalThis.fetch;
const realWarn = console.warn;

/** Stub global fetch with a fixed response; also silences the expected warn. */
function stubFetch(respond: (url: string) => Response | Promise<Response>) {
  console.warn = () => {};
  globalThis.fetch = (async (input: any) => respond(String(input))) as typeof fetch;
}

function stubFetchThrows(err: Error) {
  console.warn = () => {};
  globalThis.fetch = (async () => {
    throw err;
  }) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
});

describe("fetchSetupStatus", () => {
  it("reports the daemon's answer when the probe succeeds", async () => {
    stubFetch(() =>
      json({ complete: false, hasSystem: true, hasAccount: true, setupType: "local" }),
    );
    const status = await fetchSetupStatus();
    assert.deepEqual(status, {
      kind: "ok",
      complete: false,
      progress: {
        hasSystem: true,
        hasAccount: true,
        setupType: "local",
        spiritName: undefined,
      },
    });
  });

  it("treats a 404 as an older daemon with no setup endpoint", async () => {
    stubFetch(() => new Response("Not Found", { status: 404 }));
    assert.deepEqual(await fetchSetupStatus(), { kind: "absent" });
  });

  it("does not claim setup is complete on a 502", async () => {
    stubFetch(() => new Response("Bad Gateway", { status: 502 }));
    const status = await fetchSetupStatus();
    assert.equal(status.kind, "error");
    assert.match(status.kind === "error" ? status.message : "", /502/);
  });

  it("does not claim setup is complete when the server 500s on its own DB probe", async () => {
    stubFetch(() => json({ error: "Could not determine setup state" }, 500));
    assert.equal((await fetchSetupStatus()).kind, "error");
  });

  it("does not claim setup is complete when the fetch throws", async () => {
    stubFetchThrows(new Error("Failed to fetch"));
    const status = await fetchSetupStatus();
    assert.equal(status.kind, "error");
    assert.match(status.kind === "error" ? status.message : "", /Failed to fetch/);
  });

  it("does not claim setup is complete when the body is not JSON", async () => {
    stubFetch(() => new Response("<html>proxy error</html>", { status: 200 }));
    assert.equal((await fetchSetupStatus()).kind, "error");
  });
});

describe("fetchMe", () => {
  it("returns the user on success", async () => {
    stubFetch(() => json({ id: 1, username: "hecate", role: "admin" }));
    assert.equal((await fetchMe())?.username, "hecate");
  });

  it("returns null on 401 — the one status that means 'no session'", async () => {
    stubFetch(() => new Response("Unauthorized", { status: 401 }));
    assert.equal(await fetchMe(), null);
  });

  it("throws on 500 rather than reporting the user as logged out", async () => {
    stubFetch(() => new Response("Internal Server Error", { status: 500 }));
    await assert.rejects(fetchMe, /500/);
  });

  it("throws on a proxy 502 rather than reporting the user as logged out", async () => {
    stubFetch(() => new Response("Bad Gateway", { status: 502 }));
    await assert.rejects(fetchMe, /502/);
  });
});
