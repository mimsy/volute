import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const AGENT = readFileSync(
  resolve(import.meta.dirname, "../templates/claude/src/agent.ts"),
  "utf-8",
);

/**
 * The `daemonNotice({ ... })` calls in the claude template's agent that record context
 * loss, as source text.
 *
 * Deliberately a source scan rather than a behavioural test: these call sites sit inside
 * the SDK stream loop and can only be reached with a real SDK subprocess (#762 shipped
 * them typechecked-only for exactly that reason), while the properties that broke are
 * visible in the text — a `thread:` key, and a deictic that stopped resolving once the
 * notice could be read anywhere.
 */
function contextLostCalls(): string[] {
  const calls: string[] = [];
  const marker = "daemonNotice({";
  for (let from = 0; ; ) {
    const start = AGENT.indexOf(marker, from);
    if (start === -1) break;
    // Walk to the brace that closes the argument object, so a `})` inside a message
    // string can't truncate the slice and silently weaken every assertion below.
    let depth = 0;
    let end = -1;
    for (let i = start + marker.length - 1; i < AGENT.length; i++) {
      if (AGENT[i] === "{") depth++;
      else if (AGENT[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    assert.notEqual(end, -1, "unterminated daemonNotice call in agent.ts");
    const call = AGENT.slice(start, end);
    if (call.includes('kind: "context_lost"')) calls.push(call);
    from = end;
  }
  return calls;
}

describe("claude template context_lost notices (#768)", () => {
  it("keeps all three amnesia call sites wired", () => {
    // A guard that silently covers zero call sites is worse than no guard.
    assert.equal(
      contextLostCalls().length,
      3,
      "expected the three amnesia paths (rotation failure, resume failure, missing transcript) to record a notice",
    );
  });

  it("records them mind-level, never scoped to a thread", () => {
    // A next-turn event drains only into a turn on its own thread or into
    // MIND_LEVEL_THREAD (""), and the stock routes.json gives every channel its own
    // thread — so `main` may not run for hours. A thread-scoped amnesia notice can sit
    // undelivered while the mind carries on elsewhere, silently amnesiac, which is the
    // outcome #367 existed to prevent. Omitting `thread` is the mind-level call: the
    // notices endpoint resolves an absent thread to MIND_LEVEL_THREAD.
    for (const call of contextLostCalls()) {
      assert.ok(!/\bthread:/.test(call), `context_lost notice must not be thread-scoped:\n${call}`);
    }
  });

  it("names the thread through threadRef, not a bare deictic", () => {
    // Mind-level means it can be read from any thread, so "this thread was reset" no
    // longer points at anything. threadRef() names the thread — and declines to name an
    // ephemeral `new-*` session, whose id the mind has never seen.
    for (const call of contextLostCalls()) {
      assert.match(call, /threadRef\((session\.)?name\)/, `must name its own thread:\n${call}`);
      assert.ok(
        !/\bthis thread\b/.test(call),
        `"this thread" does not resolve when read elsewhere:\n${call}`,
      );
    }
  });

  it("gates the missing-transcript notice on lostRealContext, in the true arm (#769)", () => {
    // The gate is the whole of #769: without it, an ordinary restart tells a mind it
    // lost context it never had. Neither direction is observable in the store's own
    // tests, so pin the wiring here.
    const gate = AGENT.indexOf("if (lostRealContext(stored)) {");
    assert.notEqual(gate, -1, "the missing-transcript notice must be gated on lostRealContext");

    // Which arm the notice sits in matters as much as the gate existing. Swapping the
    // arms leaves the condition untouched while inverting the meaning to "tell the mind
    // it lost context only when nothing was lost" — #769's bug with #367's on top — so
    // assert the call lands before the `else`, not after it.
    const notice = AGENT.indexOf("daemonNotice({", gate);
    const otherwise = AGENT.indexOf("} else {", gate);
    assert.notEqual(notice, -1, "expected a notice call after the gate");
    assert.notEqual(otherwise, -1, "expected an else arm for the nothing-was-lost case");
    assert.ok(
      notice < otherwise,
      "the notice must be recorded when context WAS lost, not in the else arm",
    );
  });
});
