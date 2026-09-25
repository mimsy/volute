import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

// A mind is told when its own hooks fail (#938). The template daemon-client reads its
// env at module load, so the stub daemon and env vars must exist before the dynamic
// import below.

type Recorded = { url: string; auth?: string; body: { kind: string; message: string } };

let server: Server;
let received: Recorded[];
/** Status the stub answers GETs with — the shipped drain hook's only request. */
let getStatus = 200;
let home: string;
let hooksDir: string;
let loader: typeof import("../templates/_base/src/lib/hook-loader.js");

function writeHook(event: string, file: string, body: string): void {
  mkdirSync(join(hooksDir, event), { recursive: true });
  writeFileSync(join(hooksDir, event, file), body);
}

/** Reports are fire-and-forget; give an in-flight POST time to land before asserting. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 200));
}

describe("hook failure notices", () => {
  before(async () => {
    received = [];
    server = createServer((req: IncomingMessage, res) => {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
      });
      req.on("end", () => {
        if (req.method === "GET") {
          res.writeHead(getStatus, { "Content-Type": "application/json" });
          res.end(getStatus === 200 ? JSON.stringify({ context: null }) : "Not found");
          return;
        }
        // The loader's log lines also reach the daemon (POST /events); only notices count.
        if (!req.url?.endsWith("/notices")) {
          res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
          return;
        }
        received.push({
          url: req.url ?? "",
          auth: req.headers.authorization,
          body: JSON.parse(raw),
        });
        res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
      });
    });
    const port: number = await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    process.env.VOLUTE_DAEMON_PORT = String(port);
    process.env.VOLUTE_MIND = "hook-mind";
    process.env.VOLUTE_MIND_TOKEN = "hook-token";
    loader = await import("../templates/_base/src/lib/hook-loader.js");
  });

  after(() => {
    server.close();
  });

  beforeEach(() => {
    received.length = 0;
    loader.resetHookFailureDedupe();
    home = mkdtempSync(join(tmpdir(), "volute-hook-failures-"));
    hooksDir = join(home, ".local", "hooks");
  });

  it("reports a failing hook to the mind's own notices endpoint", async () => {
    writeHook("pre-prompt", "session-activity.sh", "echo 'daemon said 404' >&2\nexit 2\n");

    await loader.runHooks(hooksDir, "pre-prompt", {});
    await settle();

    assert.equal(received.length, 1);
    const [req] = received;
    assert.equal(req.url, "/api/v1/minds/hook-mind/notices");
    assert.equal(req.auth, "Bearer hook-token");
    assert.equal(req.body.kind, "hook_failed");
    assert.match(req.body.message, /\.local\/hooks\/pre-prompt\/session-activity\.sh/);
    assert.match(req.body.message, /exited with code 2/);
    assert.match(req.body.message, /daemon said 404/);
    assert.match(req.body.message, /\$VOLUTE_STATE_DIR\/logs\/mind\.log/);
    rmSync(home, { recursive: true, force: true });
  });

  it("tells the same failure once per quiet window, not every turn", async () => {
    writeHook("post-tool-use", "broken.sh", "exit 1\n");

    for (let i = 0; i < 3; i++) await loader.runHooks(hooksDir, "post-tool-use", {});
    await settle();
    assert.equal(received.length, 1, "a hook failing every turn must not flood the mind");

    // A different failure of the same hook is new information.
    writeHook("post-tool-use", "broken.sh", "echo 'not json'\n");
    await loader.runHooks(hooksDir, "post-tool-use", {});
    await settle();
    assert.equal(received.length, 2);
    assert.match(received[1].body.message, /isn't JSON/);
    rmSync(home, { recursive: true, force: true });
  });

  it("tells a failing notices drain in-band, since it can't deliver its own notice", async () => {
    writeHook("pre-prompt", "notices.sh", "echo 'drain failed: 404' >&2\nexit 1\n");
    writeHook("pre-prompt", "other.sh", `echo '{"additionalContext":"still here"}'\n`);

    const first = await loader.runHooks(hooksDir, "pre-prompt", {});
    await settle();

    assert.equal(received.length, 0, "a notice about the drain would wait behind the drain");
    assert.match(first.additionalContext ?? "", /\[Your hooks\] Your notices hook/);
    assert.match(first.additionalContext ?? "", /drain failed: 404/);
    assert.match(first.additionalContext ?? "", /still here/, "other hooks still contribute");

    const second = await loader.runHooks(hooksDir, "pre-prompt", {});
    assert.doesNotMatch(second.additionalContext ?? "", /Your notices hook/, "deduped in-band too");
    rmSync(home, { recursive: true, force: true });
  });

  it("says nothing about hooks that succeed", async () => {
    writeHook("pre-prompt", "fine.sh", "echo '{}'\n");
    const result = await loader.runHooks(hooksDir, "pre-prompt", {});
    await settle();
    assert.equal(received.length, 0);
    assert.equal(result.additionalContext, undefined);
    rmSync(home, { recursive: true, force: true });
  });

  it("the shipped drain hook fails loudly on a non-ok response instead of printing {}", async () => {
    // Pre-0.58 minds' drain hit a removed path and printed "{}" on the 404, so the
    // loader saw success and the mind heard nothing for weeks. Exiting non-zero is what
    // lets the loader see the failure at all.
    const shipped = resolve(
      import.meta.dirname,
      "../templates/_base/.init/.local/hooks/pre-prompt/notices.ts",
    );
    getStatus = 404;
    try {
      const result = await loader.executeHook(shipped, { session: "main" }, 30_000);
      assert.equal(result.failure?.kind, "exit", JSON.stringify(result));
      assert.match(result.failure?.output ?? "", /notices drain failed: 404/);
    } finally {
      getStatus = 200;
    }
    const ok = await loader.executeHook(shipped, { session: "main" }, 30_000);
    assert.equal(ok.failure, undefined, JSON.stringify(ok));
    rmSync(home, { recursive: true, force: true });
  });
});
