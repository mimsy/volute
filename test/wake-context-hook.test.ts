import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { _resetConfigCache } from "../packages/daemon/src/lib/config/setup.js";
import {
  resolveMindToken,
  revokeMindToken,
} from "../packages/daemon/src/lib/daemon/mind-tokens.js";
import { SleepManager, type SleepState } from "../packages/daemon/src/lib/daemon/sleep-manager.js";
import { mindDir, voluteSystemDir } from "../packages/daemon/src/lib/mind/registry.js";
import { exec } from "../packages/daemon/src/lib/util/exec.js";

/** Reach the private hook runner the way the other sleep tests reach privates. */
function runHook(sm: SleepManager, name: string, sleepingSince: string, duration: string) {
  return (
    sm as unknown as {
      runWakeContextScript: (n: string, s: string, d: string) => Promise<string>;
    }
  ).runWakeContextScript(name, sleepingSince, duration);
}

function writeHook(name: string, body: string): void {
  const hooksDir = resolve(mindDir(name), "home", ".local", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const path = resolve(hooksDir, "wake-context.sh");
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

describe("wake-context hook", () => {
  const origSandbox = process.env.VOLUTE_SANDBOX;
  const origOptional = process.env.VOLUTE_SANDBOX_OPTIONAL;

  function configPath() {
    return resolve(voluteSystemDir(), "config.json");
  }

  afterEach(() => {
    _resetConfigCache();
    try {
      unlinkSync(configPath());
    } catch {}
    if (origSandbox === undefined) delete process.env.VOLUTE_SANDBOX;
    else process.env.VOLUTE_SANDBOX = origSandbox;
    if (origOptional === undefined) delete process.env.VOLUTE_SANDBOX_OPTIONAL;
    else process.env.VOLUTE_SANDBOX_OPTIONAL = origOptional;
  });

  // #864: the shipped default hook is comments only and never reads stdin. Writing
  // the wake JSON to a pipe whose reader is gone raises EPIPE on the stdin stream;
  // with no listener there, Node kills the whole daemon — every mind with it.
  //
  // In production this is a race the daemon usually wins, so the payload here is
  // padded past the pipe buffer to force the losing side every run: the write can
  // no longer complete before the hook exits. Without the guard this test does not
  // fail — it takes the test process down with it, exactly as it took the daemon.
  it("a hook that never reads stdin does not crash the process", async () => {
    process.env.VOLUTE_SANDBOX = "0";
    delete process.env.VOLUTE_SANDBOX_OPTIONAL;
    const name = "wake-epipe-mind";
    writeHook(name, "#!/bin/bash\n# comments only, exactly like the shipped default\nexit 0\n");

    const sm = new SleepManager();
    const out = await runHook(sm, name, new Date().toISOString(), "y".repeat(200_000));
    assert.equal(out, "", "a hook that produces no output yields no wake context");
  });

  it("passes the wake JSON to a hook that does read stdin", async () => {
    process.env.VOLUTE_SANDBOX = "0";
    delete process.env.VOLUTE_SANDBOX_OPTIONAL;
    const name = "wake-stdin-mind";
    writeHook(name, "#!/bin/bash\ncat\n");

    const sm = new SleepManager();
    const since = new Date().toISOString();
    const out = await runHook(sm, name, since, "3 hours");
    const parsed = JSON.parse(out) as { sleepingSince: string; duration: string; wakeTime: string };
    assert.equal(parsed.sleepingSince, since);
    assert.equal(parsed.duration, "3 hours");
    assert.ok(parsed.wakeTime, "hook receives the wake time");
  });

  // #871: the hook is mind-authored code. It used to get `{ ...process.env }` — on a
  // --system install that is the root daemon's environment, admin token included.
  it("runs with the mind's own env and no daemon admin token", async () => {
    process.env.VOLUTE_SANDBOX = "0";
    delete process.env.VOLUTE_SANDBOX_OPTIONAL;
    const name = "wake-env-mind";
    // Bracketed so trailing empty values survive the trim runWakeContextScript applies.
    writeHook(
      name,
      '#!/bin/bash\nprintf "mind=[%s]\\ntoken=[%s]\\nadmin=[%s]\\nhost=[%s]" "$VOLUTE_MIND" "$VOLUTE_MIND_TOKEN" "$VOLUTE_DAEMON_TOKEN" "$HOST_ONLY_SECRET"\n',
    );

    process.env.VOLUTE_DAEMON_TOKEN = "super-secret-admin";
    process.env.HOST_ONLY_SECRET = "ambient-host-secret";
    try {
      const sm = new SleepManager();
      const out = await runHook(sm, name, new Date().toISOString(), "3 hours");
      const fields = new Map(
        out.split("\n").map((line) => {
          const [key, value] = line.split("=", 2);
          return [key, value.replace(/^\[|\]$/g, "")] as const;
        }),
      );
      assert.equal(fields.get("mind"), name);
      const token = fields.get("token");
      assert.ok(token && token.length > 0, "hook should receive a mind token");
      // The token is non-admin and scoped to this mind.
      assert.equal(resolveMindToken(token), name);
      // The daemon admin token is never handed to the hook (expands to empty).
      assert.equal(fields.get("admin"), "");
      // Nor is the daemon's ambient host environment.
      assert.equal(fields.get("host"), "");
    } finally {
      delete process.env.VOLUTE_DAEMON_TOKEN;
      delete process.env.HOST_ONLY_SECRET;
      revokeMindToken(name);
    }
  });

  it("routes the hook through the sandbox in sandbox mode (never bare bash)", async () => {
    // Sandbox mode with no opt-out. The sandbox runtime is not initialized in unit
    // tests, so a hook that went through the sandbox path fails closed instead of
    // running bare `bash` in the daemon's trust domain. runWakeContextScript
    // swallows hook failures, so a leaked run shows up as leaked output.
    delete process.env.VOLUTE_SANDBOX;
    delete process.env.VOLUTE_SANDBOX_OPTIONAL;
    mkdirSync(voluteSystemDir(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ setup: { isolation: "sandbox" } }));
    _resetConfigCache();

    const name = "wake-sandbox-mind";
    writeHook(name, "#!/bin/bash\necho leaked-out-of-the-sandbox\n");

    const sm = new SleepManager();
    const out = await runHook(sm, name, new Date().toISOString(), "3 hours");
    assert.equal(out, "", "hook must not run outside the sandbox when sandbox mode is on");
  });

  // Drives the whole chain — runWakeContextScript → runMindScript → exec — with a
  // hook that never returns, because that is the wiring a regression would break:
  // sleep-manager dropping `timeout: 5000`, or runMindScript failing to forward it.
  // Testing exec()'s own timeout instead would prove only what was already true
  // before this plumbing existed.
  it("gives up on a hook that hangs, instead of blocking the wake forever", async () => {
    process.env.VOLUTE_SANDBOX = "0";
    delete process.env.VOLUTE_SANDBOX_OPTIONAL;
    const name = "wake-hang-mind";
    writeHook(name, "#!/bin/bash\nsleep 120\n");

    const sm = new SleepManager();
    const started = Date.now();
    const out = await runHook(sm, name, new Date().toISOString(), "3 hours");
    const elapsed = Date.now() - started;

    assert.equal(out, "", "a timed-out hook contributes no wake context");
    // The wake path asks for 5s. Anything near the hook's own 120s means the cap
    // was lost somewhere between the call site and execFile.
    assert.ok(elapsed < 30_000, `wake waited ${elapsed}ms on a hanging hook`);
  });

  // The hook now runs through execFile, where a 1MB stdout cap would be easy to end
  // up with — it is that function's default, and MIND_SCRIPT_MAX_BUFFER is what keeps
  // the wake path off it deliberately rather than by accident. Overflow is not
  // truncation: the child is killed and the caller gets nothing, so a mind that grew
  // its own wake hook past the line would lose all of its context and never hear why.
  // 2MB is over execFile's default and far under our cap; this goes red if anyone
  // narrows the bound to that default.
  it("keeps the context of a hook whose output exceeds execFile's 1MB default", async () => {
    process.env.VOLUTE_SANDBOX = "0";
    delete process.env.VOLUTE_SANDBOX_OPTIONAL;
    const name = "wake-bigout-mind";
    // ~2MB: over execFile's 1MB default, far under the cap we set.
    writeHook(name, "#!/bin/bash\nhead -c 2097152 /dev/zero | tr '\\0' 'a'\n");

    const sm = new SleepManager();
    const out = await runHook(sm, name, new Date().toISOString(), "3 hours");
    assert.ok(out.length > 1024 * 1024, `expected the hook's full output, got ${out.length} bytes`);
  });

  // Under sandbox mode the hook is not the immediate child: wrapForSandbox returns
  // ["bash", ["-c", "env … sandbox-exec -p '…' 'bash' '<hook>'"]], and execFile's
  // timeout SIGTERMs only that immediate child. That wrapped string is a single
  // simple command, so bash exec-replaces itself all the way down and the signal
  // lands on the hook itself — verified against the real sandbox runtime, where a
  // timed-out hook left nothing behind. This pins the portable half of that shape:
  // if the wrapper ever grows into a compound command bash would fork instead of
  // exec, and a leaked process per wake is a slow bleed on exactly the storage-
  // starved hosts this fix is for.
  it("kills a hung hook's work rather than leaving it running behind the wrapper", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "wake-hook-timeout-"));
    const marker = resolve(dir, "kept-going");
    await assert.rejects(() =>
      exec("bash", ["-c", `env WRAPPED=1 bash -c 'sleep 2; echo x > ${marker}'`], { timeout: 200 }),
    );
    // Past the point the script would have written, had anything survived.
    await new Promise((r) => setTimeout(r, 2600));
    assert.ok(!existsSync(marker), "the hook's work must not outlive the timeout");
  });

  // #419/#480: a mind that fails to wake backs off, and after 5 tries the daemon
  // stops waking it altogether. A broken context hook is not a failed wake, and must
  // never be counted as one — a mind quietly dropped from its own mornings because
  // its hook has a typo is the invisible harm this whole change is against. The hook
  // runs after resetWakeBackoff() and inside its own try/catch; this pins that a hook
  // failure neither reaches handleWakeFailure nor disturbs the state it owns.
  it("a broken hook is not counted as a failed wake", async () => {
    process.env.VOLUTE_SANDBOX = "0";
    delete process.env.VOLUTE_SANDBOX_OPTIONAL;
    const name = "wake-backoff-mind";
    writeHook(name, "#!/bin/bash\necho 'hook is broken' >&2\nexit 3\n");

    let wakeFailuresRecorded = 0;
    class SpyingSleepManager extends SleepManager {
      protected override async handleWakeFailure(): Promise<void> {
        wakeFailuresRecorded++;
      }
      seedSleeping(mind: string): void {
        const state: SleepState = {
          sleeping: true,
          sleepingSince: new Date().toISOString(),
          scheduledWakeAt: null,
          wokenByTrigger: false,
          voluntaryWakeAt: null,
          queuedMessageCount: 0,
          triggerWakeHistory: [],
          wakeFailures: 0,
          nextWakeAttemptAt: null,
        } as SleepState;
        (this as any).states.set(mind, state);
      }
      stateOf(mind: string): SleepState | undefined {
        return (this as any).states.get(mind);
      }
    }

    const sm = new SpyingSleepManager();
    sm.seedSleeping(name);
    const out = await runHook(sm, name, new Date().toISOString(), "3 hours");

    assert.equal(out, "", "a failing hook yields no wake context");
    assert.equal(wakeFailuresRecorded, 0, "a hook failure is not a wake failure");
    assert.equal(sm.stateOf(name)?.wakeFailures, 0, "backoff count untouched");
    assert.equal(sm.stateOf(name)?.nextWakeAttemptAt, null, "no retry scheduled");
    assert.equal(sm.stateOf(name)?.sleeping, true, "the wake itself is unaffected");
  });
});
