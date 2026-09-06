import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Guards the exact regression from #533: the SIGTERM/SIGINT handler wired by
// setupShutdown() must run the teardown BEFORE the process exits (the bug was a
// handler that exited without reaping), and must run it only ONCE even if a
// second signal arrives mid-teardown (the idempotency guard). The pure-logic
// unit tests exercise runShutdown/reapSessionsForShutdown but cannot verify that
// an actual OS signal invokes them — this does.

const here = dirname(fileURLToPath(import.meta.url));
const startupPath = resolve(here, "../templates/_base/src/lib/startup.ts");

const workDir = mkdtempSync(resolve(tmpdir(), "shutdown-signal-"));
const fixturePath = resolve(workDir, "fixture.ts");

// A minimal mind server: wire setupShutdown() with a teardown that records each
// invocation to a marker file, then hold the event loop open with an explicit
// timer. TEARDOWN_DELAY lets a second signal land mid-run.
//
// The keepalive timer is load-bearing, not decoration: signal listeners do NOT
// ref the libuv loop, so without it the fixture exits 0 the moment module
// loading drains (~0.4s) and the test becomes a race between the parent's
// kill() and the child's own exit — which a loaded CI runner loses, failing as
// "exit 0, empty marker". setupShutdown() ends in process.exit(0), so the timer
// never delays a real shutdown.
writeFileSync(
  fixturePath,
  `import { appendFileSync } from "node:fs";
import { setupShutdown } from ${JSON.stringify(startupPath)};

const marker = process.env.MARKER_FILE;
const delayMs = Number(process.env.TEARDOWN_DELAY ?? "0");

setupShutdown(async () => {
  appendFileSync(marker, "teardown-start\\n");
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  appendFileSync(marker, "teardown-done\\n");
});

setInterval(() => {}, 60_000);

process.stdout.write("READY\\n");
`,
);

after(() => rmSync(workDir, { recursive: true, force: true }));

type Run = { code: number | null; signal: NodeJS.Signals | null; marker: string };

function runFixture(
  markerFile: string,
  onReady: (child: ReturnType<typeof spawn>) => void,
  env: Record<string, string> = {},
): Promise<Run> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", fixturePath], {
      env: { ...process.env, MARKER_FILE: markerFile, ...env },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let readyFired = false;
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      if (!readyFired && buf.includes("READY")) {
        readyFired = true;
        onReady(child);
      }
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      let marker = "";
      try {
        marker = readFileSync(markerFile, "utf-8");
      } catch {
        marker = "";
      }
      resolvePromise({ code, signal, marker });
    });
  });
}

describe("setupShutdown signal wiring", () => {
  it("runs the teardown before exiting on SIGTERM (exit 0)", async () => {
    const markerFile = resolve(workDir, "marker-a");
    const run = await runFixture(markerFile, (child) => child.kill("SIGTERM"));
    assert.equal(run.code, 0, "should exit cleanly after teardown");
    assert.ok(
      run.marker.includes("teardown-done"),
      `teardown must complete before exit; marker was: ${JSON.stringify(run.marker)}`,
    );
  });

  it("runs the teardown exactly once when a second signal arrives mid-teardown", async () => {
    const markerFile = resolve(workDir, "marker-b");
    const run = await runFixture(
      markerFile,
      (child) => {
        // Fire two signals in quick succession while the teardown is still in
        // its delay window — the idempotency guard must ignore the second.
        child.kill("SIGTERM");
        child.kill("SIGINT");
      },
      { TEARDOWN_DELAY: "300" },
    );
    assert.equal(run.code, 0);
    const starts = run.marker.split("\n").filter((l) => l === "teardown-start").length;
    assert.equal(
      starts,
      1,
      `teardown must run exactly once; marker was: ${JSON.stringify(run.marker)}`,
    );
  });
});
