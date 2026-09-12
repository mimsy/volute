import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";
import { readLastContextTokens } from "../templates/_base/src/lib/context-breakdown.js";
import {
  budgetSpent,
  createRotationGuard,
  MAX_CONSECUTIVE_ROTATIONS,
  type RotationGuard,
  recordRotation,
  shouldRotate,
} from "../templates/codex/src/lib/rotation.js";

/** The threshold the codex template ships (`templates/codex/home/.config/config.json`). */
const MAX_CONTEXT_TOKENS = 150_000;

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/**
 * The body of agent.ts's `maybeRotate`, over the real guard, with the context reader
 * stubbed. agent.ts constructs the Codex SDK at module scope, so the loop itself can't
 * be imported into a unit test; this drives the decision the loop delegates.
 *
 * `measured` is one entry per completed turn: the context read from that turn's rollout,
 * or null when it couldn't be read. `rotate` returns whether the rotation landed —
 * `performRotation` can fail (an unreadable rollout, a thread that won't resume) and
 * must not spend a slot.
 */
function runTurns(
  guard: RotationGuard,
  measured: Array<number | null>,
  rotate: () => boolean = () => true,
): number[] {
  const rotatedOnTurn: number[] = [];
  for (const [i, contextTokens] of measured.entries()) {
    if (!shouldRotate(guard, contextTokens, MAX_CONTEXT_TOKENS)) continue;
    if (rotate()) {
      recordRotation(guard);
      rotatedOnTurn.push(i);
    }
  }
  return rotatedOnTurn;
}

/**
 * #913: rotation is a controlled loss of continuity, meant to happen once per context
 * window. The gate was reading codex's session-cumulative token counter, which only
 * grows, so a codex mind crossed the threshold about four turns in and then rotated on
 * every turn for the rest of its life.
 */
describe("codex rotation: what the threshold is measured against", () => {
  it("does not rotate across a session whose cumulative counter is far over the threshold", () => {
    // The real series from a live mind: codex's `total_token_usage.input_tokens` over
    // five consecutive turns. Every one of these is over the 150k threshold, and the
    // old gate rotated on all five. What the model was actually sent each turn — the
    // rollout's `last_token_usage.input_tokens` — is the second row, and never is.
    const cumulative = [538_002, 584_162, 630_756, 677_701, 724_993];
    const measured = [42_100, 44_800, 47_300, 49_900, 52_400];
    assert.ok(cumulative.every((t) => t >= MAX_CONTEXT_TOKENS));

    const guard = createRotationGuard();
    assert.deepEqual(runTurns(guard, measured), []);
    assert.equal(budgetSpent(guard), false);
  });

  it("rotates on the turn the measured context crosses the threshold", () => {
    const guard = createRotationGuard();
    // A window filling normally, then one turn over.
    assert.deepEqual(runTurns(guard, [90_000, 120_000, 149_999, 151_000]), [3]);
  });

  it("does not rotate when no threshold is configured", () => {
    const guard = createRotationGuard();
    assert.equal(shouldRotate(guard, 500_000, undefined), false);
  });
});

/**
 * The runaway guard. Rotation seeds a verbatim tail into a fresh thread; if the context
 * is still over the threshold afterwards (a system prompt too large to fit under it),
 * rotating again buys nothing and we hand off to the SDK's native backstop.
 */
describe("codex rotation: the runaway guard", () => {
  it("stops after consecutive rotations that relieved nothing", () => {
    const guard = createRotationGuard();
    // Still over the threshold after every rotation: the tail alone can't fit.
    const rotated = runTurns(guard, Array(8).fill(400_000));
    assert.deepEqual(rotated, [0, 1, 2]);
    assert.equal(rotated.length, MAX_CONSECUTIVE_ROTATIONS);
    assert.equal(budgetSpent(guard), true);
  });

  it("keeps rotating for a mind that genuinely refills the window", () => {
    // Heavy turn, then a turn measuring 20k — which, read from the rollout, is proof the
    // rotation worked. A mind that really does fill its window every couple of turns
    // should go on rotating; capping it here would let context run past the model's own
    // limit and hand the session to codex's compaction instead.
    const guard = createRotationGuard();
    const alternating = [400_000, 20_000, 400_000, 20_000, 400_000, 20_000, 400_000, 20_000];
    assert.deepEqual(runTurns(guard, alternating), [0, 2, 4, 6]);
    assert.equal(budgetSpent(guard), false);
  });

  it("resets the streak on the first turn that comes back under the threshold", () => {
    const guard = createRotationGuard();
    // Two rotations that relieve nothing, then relief, then three more, then the cap.
    const rotated = runTurns(guard, [400_000, 400_000, 20_000, 400_000, 400_000, 400_000, 400_000]);
    assert.deepEqual(rotated, [0, 1, 3, 4, 5]);
    assert.equal(budgetSpent(guard), true);
  });

  it("neither rotates nor judges the streak on a turn it could not measure", () => {
    // No rollout figure means no evidence: rotating would have to use the turn delta,
    // which reads several times high on a tool loop, and treating it as relief or as a
    // failure would both be guesses. The SDK backstop covers a genuine runaway.
    const guard = createRotationGuard();
    runTurns(guard, [400_000, 400_000]);
    const before = guard.consecutive;
    assert.deepEqual(runTurns(guard, [null, null]), []);
    assert.equal(guard.consecutive, before);
  });

  it("does not spend a slot on a rotation that failed", () => {
    // performRotation returns early when the rollout can't be read or the new thread
    // won't resume. Counting those would disable rotation without ever rotating.
    const guard = createRotationGuard();
    assert.deepEqual(
      runTurns(guard, Array(6).fill(400_000), () => false),
      [],
    );
    assert.equal(budgetSpent(guard), false);
  });
});

/**
 * The measurement itself: codex-rs writes `last_token_usage` into the rollout on every
 * `token_count` event, and that is the size of the request it just made.
 */
describe("codex rotation: reading context from the rollout", () => {
  function rollout(lines: string[]): string {
    const dir = mkdtempSync(resolve(tmpdir(), "codex-rollout-"));
    scratch.push(dir);
    const path = resolve(dir, "rollout.jsonl");
    writeFileSync(path, `${lines.join("\n")}\n`);
    return path;
  }

  function tokenCount(last: number, total: number): string {
    return JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: last, cached_input_tokens: last - 1_000 },
          total_token_usage: { input_tokens: total },
          model_context_window: 272_000,
        },
      },
    });
  }

  it("reads the last request's size, not the thread's running total", async () => {
    // The distinction #913 turned on, in the file where both numbers sit side by side.
    const path = rollout([
      JSON.stringify({ type: "session_meta", payload: { id: "019f" } }),
      tokenCount(12_500, 12_500),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user" } }),
      tokenCount(14_056, 26_556),
      tokenCount(15_900, 42_456),
    ]);
    assert.equal(await readLastContextTokens(path), 15_900);
  });

  it("returns null when the rollout carries no usage event yet", async () => {
    const path = rollout([JSON.stringify({ type: "session_meta", payload: { id: "019f" } })]);
    assert.equal(await readLastContextTokens(path), null);
  });

  it("returns null for a rollout that isn't there", async () => {
    assert.equal(await readLastContextTokens(resolve(tmpdir(), "no-such-rollout.jsonl")), null);
  });

  it("skips malformed lines rather than failing the read", async () => {
    const path = rollout(["{not json", tokenCount(9_000, 9_000), ""]);
    assert.equal(await readLastContextTokens(path), 9_000);
  });
});
