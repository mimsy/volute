import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

// A mind is told when its own hooks fail (#938). The template daemon-client reads its
// env at module load, so the stub daemon and env vars must exist before the dynamic
// import below.

type Recorded = { url: string; auth?: string; body: { kind: string; message: string } };

let server: Server;
let received: Recorded[];
/** Status the stub answers GETs with — the shipped pre-prompt hooks' only request. */
let getStatus = 200;
/** Status the stub answers notice POSTs with. */
let noticeStatus = 200;
let home: string;
let hooksDir: string;
let loader: typeof import("../templates/_base/src/lib/hook-loader.js");

function writeHook(event: string, file: string, body: string): void {
  mkdirSync(join(hooksDir, event), { recursive: true });
  writeFileSync(join(hooksDir, event, file), body);
}

/** Run an event's hooks, then wait for any failure report they started to settle. */
async function run(event: string, input: object = {}, timeout?: number) {
  const result = await loader.runHooks(hooksDir, event, input, timeout);
  await loader.flushHookFailureReports();
  return result;
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
        res.writeHead(noticeStatus, { "Content-Type": "application/json" }).end("{}");
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
    getStatus = 200;
    noticeStatus = 200;
    loader.resetHookFailureDedupe();
    home = mkdtempSync(join(tmpdir(), "volute-hook-failures-"));
    hooksDir = join(home, ".local", "hooks");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("reports a failing hook to the mind's own notices endpoint", async () => {
    writeHook("pre-prompt", "session-activity.sh", "echo 'daemon said 404' >&2\nexit 2\n");

    await run("pre-prompt");

    assert.equal(received.length, 1);
    const [req] = received;
    assert.equal(req.url, "/api/v1/minds/hook-mind/notices");
    assert.equal(req.auth, "Bearer hook-token");
    assert.equal(req.body.kind, "hook_failed");
    assert.match(req.body.message, /\.local\/hooks\/pre-prompt\/session-activity\.sh/);
    assert.match(req.body.message, /exited with code 2/);
    assert.match(req.body.message, /daemon said 404/);
    assert.match(req.body.message, /\$VOLUTE_STATE_DIR\/logs\/mind\.log/);
  });

  it("tells the same failure once per quiet window, not every turn", async () => {
    writeHook("post-tool-use", "broken.sh", "exit 1\n");

    for (let i = 0; i < 3; i++) await run("post-tool-use");
    assert.equal(received.length, 1, "a hook failing every turn must not flood the mind");

    // A different failure of the same hook is new information.
    writeHook("post-tool-use", "broken.sh", "echo 'not json'\n");
    await run("post-tool-use");
    assert.equal(received.length, 2);
    assert.match(received[1].body.message, /isn't JSON/);
  });

  it("keeps trying when the daemon didn't record the notice", async () => {
    // A report that never landed must not start the quiet window — otherwise a daemon
    // restart mid-report silences the failure for an hour.
    writeHook("post-tool-use", "broken.sh", "exit 1\n");
    noticeStatus = 500;
    await run("post-tool-use");
    assert.equal(received.length, 1);

    noticeStatus = 200;
    await run("post-tool-use");
    assert.equal(received.length, 2, "the failed report is retried on the next failure");

    await run("post-tool-use");
    assert.equal(received.length, 2, "and once recorded, the quiet window holds");
  });

  it("tells a failing notices drain in-band, per session, and never goes silent", async () => {
    writeHook("pre-prompt", "notices.sh", "echo 'drain failed: 404' >&2\nexit 1\n");
    writeHook("pre-prompt", "other.sh", `echo '{"additionalContext":"still here"}'\n`);

    const first = await run("pre-prompt", { session: "a" });
    assert.equal(received.length, 0, "a notice about the drain would wait behind the drain");
    assert.match(first.additionalContext ?? "", /\[Your hooks\] Your notices hook/);
    assert.match(first.additionalContext ?? "", /drain failed: 404/);
    assert.match(first.additionalContext ?? "", /still here/, "other hooks still contribute");

    // The SDK can cancel a pre-prompt hook on interrupt, so nothing confirms the note
    // was seen: every failing turn still says the notices are held, just briefly.
    const again = await run("pre-prompt", { session: "a" });
    assert.match(again.additionalContext ?? "", /notices hook .* is still failing/);
    assert.doesNotMatch(again.additionalContext ?? "", /drain failed: 404/, "brief, not repeated");

    // Another session holds its own notices and needs the full story itself.
    const other = await run("pre-prompt", { session: "b" });
    assert.match(other.additionalContext ?? "", /drain failed: 404/);
  });

  it("says a timeout was a squeeze, not the hook's fault, when earlier hooks ate the budget", async () => {
    writeHook("post-tool-use", "a-slow.js", "setTimeout(() => console.log('{}'), 2500);\n");
    writeHook("post-tool-use", "b-victim.js", "setTimeout(() => console.log('{}'), 5000);\n");

    await run("post-tool-use", {}, 3000);

    const victim = received.find((r) => r.body.message.includes("b-victim.js"));
    assert.ok(victim, JSON.stringify(received));
    assert.match(victim.body.message, /may not be its fault/);
    assert.match(victim.body.message, /shared 3000ms budget/);
    assert.doesNotMatch(
      victim.body.message,
      /yours to look into/,
      "don't point at a squeezed hook",
    );
  });

  it("names a skill's own script rather than the regenerated shim", async () => {
    // The exact shape installHookShims generates, relative script path included.
    writeHook(
      "post-tool-use",
      "zz-dreaming.sh",
      `#!/bin/bash\nexec bash .claude/skills/dreaming/scripts/hook.sh "$@"\n`,
    );

    await run("post-tool-use");

    assert.equal(received.length, 1);
    const { message } = received[0].body;
    assert.match(
      message,
      /from your dreaming skill \(\.claude\/skills\/dreaming\/scripts\/hook\.sh/,
    );
    assert.match(message, /shim is regenerated from the skill/);
  });

  it("says nothing about hooks that succeed", async () => {
    writeHook("pre-prompt", "fine.sh", "echo '{}'\n");
    const result = await run("pre-prompt");
    assert.equal(received.length, 0);
    assert.equal(result.additionalContext, undefined);
  });

  for (const hook of ["notices.ts", "session-activity.ts", "turn-context.ts"]) {
    it(`the shipped ${hook} fails loudly on a non-ok response instead of printing {}`, async () => {
      // Pre-0.58 minds' drain hit a removed path and printed "{}" on the 404, so the
      // loader saw success and the mind heard nothing for weeks. Exiting non-zero is
      // what lets the loader see the failure at all.
      const shipped = resolve(
        import.meta.dirname,
        "../templates/_base/.init/.local/hooks/pre-prompt",
        hook,
      );
      getStatus = 404;
      const result = await loader.executeHook(shipped, { session: "main" }, 30_000);
      assert.equal(result.failure?.kind, "exit", JSON.stringify(result));
      assert.match(result.failure?.output ?? "", /failed: 404/);

      getStatus = 200;
      const ok = await loader.executeHook(shipped, { session: "main" }, 30_000);
      assert.equal(ok.failure, undefined, JSON.stringify(ok));
    });
  }
});
