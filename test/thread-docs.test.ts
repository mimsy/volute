import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { getTurnLimits, setTurnLimits } from "../packages/daemon/src/lib/daemon/turn-slots.js";
import { newEphemeralSession } from "../packages/daemon/src/lib/util/session-name.js";

// VOLUTE.md's "Threads" section and the volute-mind skill's "Threads" section tell minds
// how their threads work. Minds reason about themselves from that text — a claim that
// drifts false here becomes a false belief about their own structure. Each assertion
// pins one claim to the code that makes it true.
const read = (p: string) => readFileSync(resolve(import.meta.dirname, "..", p), "utf-8");

describe("thread docs claims", () => {
  it("one turn at a time across threads by default", () => {
    setTurnLimits({});
    assert.equal(getTurnLimits().mindConcurrentTurns, 1);
  });

  it("a schedule waits at most a minute for a slot", () => {
    assert.match(
      read("packages/daemon/src/lib/daemon/turn-slots.ts"),
      /const SLOT_WAIT_TIMEOUT_MS = 60_000;/,
    );
  });

  it("a turn slot stops holding other threads back after half an hour", () => {
    assert.match(
      read("packages/daemon/src/lib/daemon/turn-slots.ts"),
      /const SLOT_MAX_AGE_MS = 30 \* 60_000;/,
    );
  });

  it("which templates seed a fresh thread with recollection", () => {
    // codex gained recollection in #1192; VOLUTE.md's "on the claude framework" and the
    // memory skill's claude-only lines are now stale for it, and are corrected in the docs
    // pass that follows this wave. When pi gains it too this fails on purpose.
    assert.match(read("templates/claude/src/agent.ts"), /seedSession\(\{[^}]*recollect,/s);
    assert.match(read("templates/codex/src/agent.ts"), /daemonRecollection/);
    assert.doesNotMatch(read("templates/pi/src/agent.ts"), /recollect/, "pi");
  });

  it("$new threads are named new-<timestamp>-<random>", () => {
    assert.match(newEphemeralSession(), /^new-\d+-[a-z0-9]+$/);
  });

  it("`volute mind history --thread` exists", () => {
    assert.match(
      read("packages/cli/src/commands/mind-history.ts"),
      /thread: \{ type: "string", description: "Filter by thread" \}/,
    );
  });

  it("pre-prompt hooks get the thread as `session` on stdin, in every template", () => {
    // The skill tells minds stdin is the source to trust on an outdated template, where
    // hooks ran with the server's own environment (#1173 binds VOLUTE_SESSION for them).
    for (const t of ["claude", "pi", "codex"]) {
      const src = read(`templates/${t}/src/agent.ts`);
      assert.match(src, /runHooks\(hooksDir, [^)]*\{[^}]*session: session\.name/s, t);
    }
  });
});
