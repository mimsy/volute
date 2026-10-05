import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { BridgeManager } from "../packages/daemon/src/lib/daemon/bridge-manager.js";
import log from "../packages/daemon/src/lib/util/logger.js";

// #1370: a bridge exits on its own when the daemon that spawned it goes away, so a
// crashed daemon never leaves one running on the platform token.

const repoRoot = resolve(import.meta.dirname, "..");
const bridgeSdk = resolve(repoRoot, "packages/daemon/src/lib/bridges/bridge-sdk.ts");

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await delay(25);
  }
  return cond();
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let dir: string;

/**
 * A bridge on the real bridge SDK that does nothing but stay up, and whose cleanup runs
 * `cleanupBody` and then records that it finished.
 */
function sdkBridge(name: string, cleanupBody: string) {
  const bridge = resolve(dir, `${name}.ts`);
  const ready = resolve(dir, `${name}.ready`);
  const cleaned = resolve(dir, `${name}.cleaned`);
  writeFileSync(
    bridge,
    `import { writeFileSync } from "node:fs";
import { onShutdown } from ${JSON.stringify(bridgeSdk)};
onShutdown(async () => {
  ${cleanupBody}
  writeFileSync(${JSON.stringify(cleaned)}, "yes");
});
writeFileSync(${JSON.stringify(ready)}, String(process.pid));
setInterval(() => {}, 1000);
`,
  );
  return { bridge, ready, cleaned };
}

/** Run an SDK bridge straight from the test, its stdin as given. */
async function runSdkBridge(bridge: string, ready: string, stdin: "pipe" | "ignore") {
  const child = spawn(process.execPath, ["--import", "tsx", bridge], {
    cwd: repoRoot,
    stdio: [stdin, "ignore", "ignore"],
  });
  child.stdin?.on("error", () => {});
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  assert.ok(await waitFor(() => existsSync(ready), 15000), "bridge never started");
  return {
    child,
    exitsWithin: (ms: number) =>
      Promise.race([exited.then(() => true), delay(ms).then(() => false)]),
  };
}

before(() => {
  dir = mkdtempSync(resolve(tmpdir(), "volute-bridge-watch-"));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("bridge parent watch", () => {
  it("a bridge exits, cleaning up, when its daemon is SIGKILLed", async () => {
    // Writes to the dead daemon's stdout/stderr pipes must not cut the cleanup short.
    const { bridge, ready, cleaned } = sdkBridge(
      "killed",
      `console.log("stopping");
  console.error("stopping");
  await new Promise((r) => setTimeout(r, 100));
  console.error("still stopping");`,
    );
    // A stand-in daemon that spawns it the way BridgeManager does, then idles.
    const daemon = resolve(dir, "daemon.cjs");
    writeFileSync(
      daemon,
      `const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["--import", "tsx", ${JSON.stringify(bridge)}], {
  stdio: ["pipe", "pipe", "pipe"],
  detached: true,
});
child.stdin.on("error", () => {});
setInterval(() => {}, 1000);
`,
    );
    const parent = spawn(process.execPath, [daemon], { cwd: repoRoot, stdio: "ignore" });
    let bridgePid = 0;
    try {
      assert.ok(await waitFor(() => existsSync(ready), 15000), "bridge never started");
      bridgePid = Number(readFileSync(ready, "utf-8"));
      await delay(300);
      assert.ok(alive(bridgePid), "bridge exited while its daemon was still up");

      parent.kill("SIGKILL");
      assert.ok(await waitFor(() => !alive(bridgePid), 5000), "bridge outlived its daemon");
      assert.equal(existsSync(cleaned), true, "bridge exited without running its cleanup");
    } finally {
      parent.kill("SIGKILL");
      if (bridgePid && alive(bridgePid)) process.kill(bridgePid, "SIGKILL");
    }
  });

  it("a bridge given /dev/null for stdin, as daemons before #1370 did, stays up", async () => {
    const { bridge, ready, cleaned } = sdkBridge("devnull", "");
    const { child, exitsWithin } = await runSdkBridge(bridge, ready, "ignore");
    try {
      assert.equal(await exitsWithin(1000), false, "bridge on /dev/null exited on its own");
      child.kill("SIGTERM");
      assert.equal(await exitsWithin(5000), true);
      assert.equal(existsSync(cleaned), true);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("a cleanup that hangs still ends once the daemon is gone", async () => {
    const { bridge, ready } = sdkBridge("hang", "await new Promise(() => {});");
    const { child, exitsWithin } = await runSdkBridge(bridge, ready, "pipe");
    try {
      // The daemon's stop begins, and the daemon dies before its SIGKILL.
      child.kill("SIGTERM");
      assert.equal(await exitsWithin(500), false, "the hanging cleanup didn't hang");
      child.stdin!.destroy();
      assert.equal(await exitsWithin(10000), true, "bridge hung on past its daemon");
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("a second signal ends a cleanup that hangs", async () => {
    const { bridge, ready } = sdkBridge("twice", "await new Promise(() => {});");
    const { child, exitsWithin } = await runSdkBridge(bridge, ready, "pipe");
    try {
      child.kill("SIGTERM");
      assert.equal(await exitsWithin(500), false, "the hanging cleanup didn't hang");
      child.kill("SIGTERM");
      assert.equal(await exitsWithin(3000), true, "a second SIGTERM didn't end it");
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("BridgeManager hands each bridge a stdin pipe it holds open", async () => {
    const priorToken = process.env.VOLUTE_DAEMON_TOKEN;
    process.env.VOLUTE_DAEMON_TOKEN = "test-token";
    log.setOutput(() => {});
    // A bridge that exits the moment its stdin ends, as the real ones do.
    const script = resolve(dir, "stdin-bridge.cjs");
    writeFileSync(
      script,
      `process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
setInterval(() => {}, 1000);
`,
    );
    const mgr = new BridgeManager() as any;
    mgr.knownPlatform = () => true;
    mgr.resolveBuiltinBridge = () => script;
    try {
      await mgr.startBridge("stdinwatch", 1618);
      const child = mgr.bridges.get("stdinwatch").child;
      await delay(500);
      assert.equal(mgr.isRunning("stdinwatch"), true, "bridge saw EOF while the daemon was up");

      // What the daemon's exit does to the pipe.
      const exited = new Promise((r) => child.once("exit", r));
      child.stdin.destroy();
      assert.ok(
        await Promise.race([exited.then(() => true), delay(5000).then(() => false)]),
        "bridge did not exit when its stdin closed",
      );
    } finally {
      await mgr.stopAll();
      log.setOutput((line) => process.stderr.write(`${line}\n`));
      if (priorToken === undefined) delete process.env.VOLUTE_DAEMON_TOKEN;
      else process.env.VOLUTE_DAEMON_TOKEN = priorToken;
    }
  });

  it("every built-in bridge registers its shutdown through the bridge SDK", () => {
    for (const platform of ["discord", "slack", "telegram"]) {
      const src = readFileSync(
        resolve(repoRoot, `packages/daemon/src/lib/bridges/${platform}-bridge.ts`),
        "utf-8",
      );
      assert.match(src, /import \{[^}]*\bonShutdown\b[^}]*\} from "\.\/bridge-sdk\.js"/, platform);
      assert.match(src, /^onShutdown\(/m, platform);
    }
  });
});
