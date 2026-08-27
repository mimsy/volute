import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AggregatedResult } from "../templates/_base/src/lib/hook-loader.js";
import {
  defaultHookTimeout,
  discoverHooks,
  executeHook,
  runHooks,
} from "../templates/_base/src/lib/hook-loader.js";

const testDir = join(tmpdir(), `volute-hook-loader-test-${process.pid}`);

before(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  mkdirSync(testDir, { recursive: true });
});

after(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("discoverHooks", () => {
  it("returns empty array when directory does not exist", () => {
    const result = discoverHooks(join(testDir, "nonexistent"), "pre-prompt");
    assert.deepEqual(result, []);
  });

  it("discovers .sh scripts sorted alphabetically", () => {
    const eventDir = join(testDir, "hooks-discover", "pre-prompt");
    mkdirSync(eventDir, { recursive: true });
    writeFileSync(join(eventDir, "50-resonance.sh"), "#!/bin/bash\necho ok");
    writeFileSync(join(eventDir, "10-early.sh"), "#!/bin/bash\necho ok");
    writeFileSync(join(eventDir, "90-late.sh"), "#!/bin/bash\necho ok");
    writeFileSync(join(eventDir, "readme.txt"), "not a hook"); // should be filtered

    const result = discoverHooks(join(testDir, "hooks-discover"), "pre-prompt");
    assert.equal(result.length, 3);
    assert.ok(result[0].endsWith("10-early.sh"));
    assert.ok(result[1].endsWith("50-resonance.sh"));
    assert.ok(result[2].endsWith("90-late.sh"));
  });

  it("discovers .ts and .js scripts", () => {
    const eventDir = join(testDir, "hooks-ext", "post-tool-use");
    mkdirSync(eventDir, { recursive: true });
    writeFileSync(join(eventDir, "10-hook.ts"), "console.log('{}')");
    writeFileSync(join(eventDir, "20-hook.js"), "console.log('{}')");

    const result = discoverHooks(join(testDir, "hooks-ext"), "post-tool-use");
    assert.equal(result.length, 2);
    assert.ok(result[0].endsWith("10-hook.ts"));
    assert.ok(result[1].endsWith("20-hook.js"));
  });
});

describe("executeHook", () => {
  it("runs a shell script and parses JSON output", async () => {
    const scriptDir = join(testDir, "exec-test");
    mkdirSync(scriptDir, { recursive: true });
    const script = join(scriptDir, "test.sh");
    writeFileSync(
      script,
      '#!/bin/bash\nread input\necho \'{"additionalContext": "hello from hook"}\'',
      { mode: 0o755 },
    );

    const result = await executeHook(script, { prompt: "test" });
    assert.equal(result.additionalContext, "hello from hook");
  });

  it("returns empty result for non-zero exit code", async () => {
    const scriptDir = join(testDir, "exec-fail");
    mkdirSync(scriptDir, { recursive: true });
    const script = join(scriptDir, "fail.sh");
    writeFileSync(script, "#!/bin/bash\nexit 1", { mode: 0o755 });

    const result = await executeHook(script, {});
    assert.deepEqual(result, {});
  });

  it("returns empty result for non-JSON output", async () => {
    const scriptDir = join(testDir, "exec-bad-json");
    mkdirSync(scriptDir, { recursive: true });
    const script = join(scriptDir, "bad.sh");
    writeFileSync(script, '#!/bin/bash\necho "not json"', { mode: 0o755 });

    const result = await executeHook(script, {});
    assert.deepEqual(result, {});
  });

  it("returns empty result for empty output", async () => {
    const scriptDir = join(testDir, "exec-empty");
    mkdirSync(scriptDir, { recursive: true });
    const script = join(scriptDir, "empty.sh");
    writeFileSync(script, "#!/bin/bash\n# nothing", { mode: 0o755 });

    const result = await executeHook(script, {});
    assert.deepEqual(result, {});
  });

  it("passes input as JSON on stdin", async () => {
    const scriptDir = join(testDir, "exec-stdin");
    mkdirSync(scriptDir, { recursive: true });
    // Use a .js script to read and parse stdin — no python dependency
    const script = join(scriptDir, "echo.js");
    writeFileSync(
      script,
      `let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const p=JSON.parse(d).prompt||"";console.log(JSON.stringify({additionalContext:"got: "+p}))});`,
      { mode: 0o755 },
    );

    const result = await executeHook(script, { prompt: "hello" });
    assert.equal(result.additionalContext, "got: hello");
  });

  it("handles timeout gracefully", async () => {
    const scriptDir = join(testDir, "exec-timeout");
    mkdirSync(scriptDir, { recursive: true });
    const script = join(scriptDir, "slow.sh");
    writeFileSync(script, "#!/bin/bash\nsleep 10\necho '{}'", { mode: 0o755 });

    const result = await executeHook(script, {}, 500);
    assert.deepEqual(result, {});
  });

  it("parses decision field", async () => {
    const scriptDir = join(testDir, "exec-decision");
    mkdirSync(scriptDir, { recursive: true });
    const script = join(scriptDir, "block.sh");
    writeFileSync(script, '#!/bin/bash\nread input\necho \'{"decision": "block"}\'', {
      mode: 0o755,
    });

    const result = await executeHook(script, {});
    assert.equal(result.decision, "block");
  });

  it("parses metadata field", async () => {
    const scriptDir = join(testDir, "exec-metadata");
    mkdirSync(scriptDir, { recursive: true });
    const script = join(scriptDir, "meta.sh");
    writeFileSync(script, '#!/bin/bash\nread input\necho \'{"metadata": {"source": "test"}}\'', {
      mode: 0o755,
    });

    const result = await executeHook(script, {});
    assert.deepEqual(result.metadata, { source: "test" });
  });
});

describe("runHooks", () => {
  it("returns empty result when no hooks exist", async () => {
    const result = await runHooks(join(testDir, "no-hooks"), "pre-prompt", {});
    assert.equal(result.additionalContext, undefined);
    assert.deepEqual(result.metadata, {});
    assert.equal(result.blocked, false);
  });

  it("aggregates context from multiple hooks", async () => {
    const hooksDir = join(testDir, "run-hooks-multi");
    const eventDir = join(hooksDir, "pre-prompt");
    mkdirSync(eventDir, { recursive: true });

    writeFileSync(
      join(eventDir, "10-first.sh"),
      '#!/bin/bash\nread input\necho \'{"additionalContext": "first"}\'',
      { mode: 0o755 },
    );
    writeFileSync(
      join(eventDir, "20-second.sh"),
      '#!/bin/bash\nread input\necho \'{"additionalContext": "second"}\'',
      { mode: 0o755 },
    );

    const result = await runHooks(hooksDir, "pre-prompt", {});
    assert.equal(result.additionalContext, "first\n\nsecond");
  });

  it("continues past failing hooks", async () => {
    const hooksDir = join(testDir, "run-hooks-fail");
    const eventDir = join(hooksDir, "pre-prompt");
    mkdirSync(eventDir, { recursive: true });

    writeFileSync(join(eventDir, "10-fail.sh"), "#!/bin/bash\nexit 1", { mode: 0o755 });
    writeFileSync(
      join(eventDir, "20-ok.sh"),
      '#!/bin/bash\nread input\necho \'{"additionalContext": "survived"}\'',
      { mode: 0o755 },
    );

    const result = await runHooks(hooksDir, "pre-prompt", {});
    assert.equal(result.additionalContext, "survived");
  });

  it("sets blocked when any hook returns block decision", async () => {
    const hooksDir = join(testDir, "run-hooks-block");
    const eventDir = join(hooksDir, "pre-prompt");
    mkdirSync(eventDir, { recursive: true });

    writeFileSync(
      join(eventDir, "10-blocker.sh"),
      '#!/bin/bash\nread input\necho \'{"decision": "block"}\'',
      { mode: 0o755 },
    );

    const result = await runHooks(hooksDir, "pre-prompt", {});
    assert.equal(result.blocked, true);
  });

  it("merges metadata from multiple hooks", async () => {
    const hooksDir = join(testDir, "run-hooks-meta");
    const eventDir = join(hooksDir, "pre-prompt");
    mkdirSync(eventDir, { recursive: true });

    writeFileSync(
      join(eventDir, "10-a.sh"),
      '#!/bin/bash\nread input\necho \'{"metadata": {"a": 1}}\'',
      { mode: 0o755 },
    );
    writeFileSync(
      join(eventDir, "20-b.sh"),
      '#!/bin/bash\nread input\necho \'{"metadata": {"b": 2}}\'',
      { mode: 0o755 },
    );

    const result = await runHooks(hooksDir, "pre-prompt", {});
    assert.deepEqual(result.metadata, { a: 1, b: 2 });
  });
});

/** Collect the logger's output (it writes via console.error) while `fn` runs. */
async function captureLog(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines.join("\n");
}

describe("hook timeouts", () => {
  it("reports a timeout as a timeout, not as an unexplained null exit", async () => {
    // spawn()'s `timeout` kills the child with a signal, so `code` is null. The
    // old message ("exited with code null") sent hosts hunting for a crash: on the
    // production Pi it accounted for ~150 lines per mind per fortnight, all of them
    // just tsx cold-starting past a 5s budget.
    const scriptDir = join(testDir, "timeout-msg");
    mkdirSync(scriptDir, { recursive: true });
    const script = join(scriptDir, "slow.js");
    // A node script rather than `bash sleep`: killing bash leaves `sleep` holding
    // the stdout pipe open, so the test would wait out the full sleep either way.
    writeFileSync(script, "setTimeout(() => console.log('{}'), 60000);\n");

    let result: unknown;
    const logged = await captureLog(async () => {
      result = await executeHook(script, {}, 300);
    });

    assert.deepEqual(result, {}, "a timed-out hook must degrade to no context, not throw");
    assert.match(logged, /timed out after 300ms/, `log was: ${logged}`);
    assert.match(logged, /VOLUTE_HOOK_TIMEOUT_MS/, "the message must say how to raise it");
    assert.doesNotMatch(logged, /exited with code null/);
  });

  it("defaults to 15s, and honours VOLUTE_HOOK_TIMEOUT_MS", () => {
    const original = process.env.VOLUTE_HOOK_TIMEOUT_MS;
    try {
      delete process.env.VOLUTE_HOOK_TIMEOUT_MS;
      assert.equal(defaultHookTimeout(), 15000);

      process.env.VOLUTE_HOOK_TIMEOUT_MS = "30000";
      assert.equal(defaultHookTimeout(), 30000);

      // Read per call, so a host can retune without a rebuild.
      process.env.VOLUTE_HOOK_TIMEOUT_MS = "1000";
      assert.equal(defaultHookTimeout(), 1000);

      // Garbage falls back rather than producing a zero/negative timeout, which
      // spawn() would treat as "kill immediately" — every hook dead on arrival.
      for (const bad of ["", "0", "-1", "soon", "NaN"]) {
        process.env.VOLUTE_HOOK_TIMEOUT_MS = bad;
        assert.equal(defaultHookTimeout(), 15000, `"${bad}" must fall back to the default`);
      }
    } finally {
      if (original === undefined) delete process.env.VOLUTE_HOOK_TIMEOUT_MS;
      else process.env.VOLUTE_HOOK_TIMEOUT_MS = original;
    }
  });

  it("still reports a genuine non-zero exit as an exit", async () => {
    const scriptDir = join(testDir, "exit-msg");
    mkdirSync(scriptDir, { recursive: true });
    const script = join(scriptDir, "fail.sh");
    writeFileSync(script, "#!/bin/bash\nexit 3");

    const logged = await captureLog(async () => {
      await executeHook(script, {}, 5000);
    });

    assert.match(logged, /exited with code 3/, `log was: ${logged}`);
    assert.doesNotMatch(logged, /timed out/);
  });
});

describe("aggregate hook budget", () => {
  it("bounds the whole event, not each hook, so 3 slow hooks aren't 3x the stall", async () => {
    // Raising the per-hook budget to 15s is only an improvement if the pre-turn
    // stall doesn't triple with it: `_base` ships three pre-prompt hooks and they
    // run in series.
    const hooksDir = join(testDir, "budget-hooks");
    const eventDir = join(hooksDir, "pre-prompt");
    mkdirSync(eventDir, { recursive: true });
    for (const n of ["10", "20", "30"]) {
      writeFileSync(
        join(eventDir, `${n}-slow.js`),
        "setTimeout(() => console.log('{}'), 60000);\n",
      );
    }

    const started = Date.now();
    await captureLog(async () => {
      await runHooks(hooksDir, "pre-prompt", {}, 1500);
    });
    const elapsed = Date.now() - started;

    // Budget 1500ms + two 1000ms floors for the hooks that start past the
    // deadline, plus spawn overhead. Without the cap this would be ~4500ms.
    assert.ok(elapsed < 4200, `hooks took ${elapsed}ms; the event budget was not applied`);
  });

  it("still gives a later hook a floor rather than spawning it dead", async () => {
    // A hook that starts past the deadline must still get a real timeout: a
    // zero-length one makes spawn kill it on arrival, which is the failure this
    // whole PR is about. (Sort order puts the notices drain first, so the hook
    // being protected here is the tail — turn-context.ts in the shipped set.)
    const hooksDir = join(testDir, "floor-hooks");
    const eventDir = join(hooksDir, "pre-prompt");
    mkdirSync(eventDir, { recursive: true });
    writeFileSync(join(eventDir, "10-slow.js"), "setTimeout(() => console.log('{}'), 60000);\n");
    writeFileSync(
      join(eventDir, "20-fast.js"),
      "console.log(JSON.stringify({ additionalContext: 'i still ran' }));\n",
    );

    let result: AggregatedResult | undefined;
    await captureLog(async () => {
      result = await runHooks(hooksDir, "pre-prompt", {}, 300);
    });

    assert.equal(result?.additionalContext, "i still ran");
  });
});
