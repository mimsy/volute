import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * Tests the pre-compact hook state machine logic.
 *
 * The actual hook lives in templates/claude/src/lib/hooks/pre-compact.ts
 * but can't be imported directly in tests due to template-internal dependencies.
 * This test replicates the exact algorithm to validate the state machine.
 */

type HookResult = { decision?: string } | undefined;

function createPreCompactHook(onCompact: () => void) {
  let compactBlocked = false;

  const hook = (trigger: string, custom_instructions?: string): HookResult => {
    // Our custom compaction (via /compact with instructions) — allow through
    if (trigger === "manual" && custom_instructions) {
      return {};
    }

    // Auto-compaction: two-pass block (first pass warns mind, second pass allows)
    if (!compactBlocked) {
      try {
        onCompact();
        compactBlocked = true;
      } catch {
        return {};
      }
      return { decision: "block" };
    }
    compactBlocked = false;
    return {};
  };

  return { hook };
}

describe("pre-compact hook state machine", () => {
  it("manual trigger with custom_instructions passes through", () => {
    const calls: string[] = [];
    const { hook } = createPreCompactHook(() => calls.push("onCompact"));

    const result = hook("manual", "preserve identity");

    assert.deepEqual(result, {});
    assert.equal(calls.length, 0, "onCompact should not be called for manual compaction");
  });

  it("manual trigger without custom_instructions follows two-pass logic", () => {
    const calls: string[] = [];
    const { hook } = createPreCompactHook(() => calls.push("onCompact"));

    const result1 = hook("manual");
    assert.deepEqual(result1, { decision: "block" });
    assert.equal(calls.length, 1);

    const result2 = hook("manual");
    assert.deepEqual(result2, {});
  });

  it("auto trigger first call blocks and calls onCompact", () => {
    const calls: string[] = [];
    const { hook } = createPreCompactHook(() => calls.push("onCompact"));

    const result = hook("auto");

    assert.deepEqual(result, { decision: "block" });
    assert.equal(calls.length, 1);
  });

  it("auto trigger second call allows and resets state", () => {
    const calls: string[] = [];
    const { hook } = createPreCompactHook(() => calls.push("onCompact"));

    // First: block
    hook("auto");
    assert.equal(calls.length, 1);

    // Second: allow
    const result = hook("auto");
    assert.deepEqual(result, {});

    // Third: should block again (state was reset)
    const result3 = hook("auto");
    assert.deepEqual(result3, { decision: "block" });
    assert.equal(calls.length, 2);
  });

  it("manual pass-through does not affect compactBlocked state", () => {
    const calls: string[] = [];
    const { hook } = createPreCompactHook(() => calls.push("onCompact"));

    // Auto: block
    hook("auto");
    assert.equal(calls.length, 1);

    // Manual with instructions: pass through (should not reset compactBlocked)
    const manual = hook("manual", "preserve");
    assert.deepEqual(manual, {});

    // Auto again: should allow (compactBlocked was still true from first call)
    const result = hook("auto");
    assert.deepEqual(result, {});
  });

  it("onCompact failure allows compaction through gracefully", () => {
    const { hook } = createPreCompactHook(() => {
      throw new Error("callback failed");
    });

    // Should not throw, should return {} (allow through)
    const result = hook("auto");
    assert.deepEqual(result, {});
  });

  it("onCompact failure does not leave compactBlocked in stuck state", () => {
    let shouldFail = true;
    const { hook } = createPreCompactHook(() => {
      if (shouldFail) throw new Error("fail");
    });

    // First call: onCompact fails, compactBlocked stays false, allows through
    const r1 = hook("auto");
    assert.deepEqual(r1, {});

    // Second call: onCompact still fails, same behavior
    const r2 = hook("auto");
    assert.deepEqual(r2, {});

    // Fix the callback
    shouldFail = false;

    // Third call: onCompact succeeds, should block
    const r3 = hook("auto");
    assert.deepEqual(r3, { decision: "block" });

    // Fourth call: should allow
    const r4 = hook("auto");
    assert.deepEqual(r4, {});
  });
});
