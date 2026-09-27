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

  it("every template seeds a fresh thread with recollection", () => {
    // VOLUTE.md's Threads section and the volute-mind skill say so for every framework
    // (#1192), naming the exceptions: `$new` threads, nothing to continue, recollection off.
    assert.match(read("templates/claude/src/agent.ts"), /seedSession\(\{[^}]*recollect,/s);
    assert.match(read("templates/codex/src/agent.ts"), /daemonRecollection/);
    assert.match(read("templates/pi/src/agent.ts"), /seedPiSession\(\{[^}]*recollect,/s);
    assert.match(read("templates/pi/src/agent.ts"), /rotatePiSession\(\{[^}]*recollect,/s);
    for (const doc of ["templates/_base/home/VOLUTE.md", "skills/volute-mind/SKILL.md"]) {
      assert.doesNotMatch(
        read(doc),
        /on the claude (and codex )?frameworks?[^.]*recollection/i,
        doc,
      );
      assert.match(read(doc), /usually also[^.]*recollection[^.]*`\$new` thread/s, doc);
    }
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
