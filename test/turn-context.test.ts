import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ExtensionManifest } from "@volute/extensions";
import {
  _clearLoadedExtensionsForTest,
  _registerExtensionForTest,
  getTurnContextProviders,
} from "../packages/daemon/src/lib/extensions.js";
import {
  collectFromProviders,
  collectTurnContext,
  TURN_CONTEXT_BUDGET,
  type TurnContextProviderLike,
} from "../packages/daemon/src/lib/turn-context.js";

function provider(id: string, run: (budget: number) => Promise<string | null>) {
  return { id, run } satisfies TurnContextProviderLike;
}

/** A provider that always answers with `n` characters, recording the budget it was offered. */
function sized(id: string, n: number, seen: number[] = []) {
  return {
    entry: provider(id, async (budget) => {
      seen.push(budget);
      return "x".repeat(n);
    }),
    seen,
  };
}

describe("collectFromProviders — budget policy", () => {
  it("returns null when nothing is loaded", async () => {
    assert.equal(await collectFromProviders([], "turn"), null);
  });

  it("returns null when every extension is quiet — the normal case", async () => {
    const calls: string[] = [];
    const providers = ["a", "b", "c"].map((id) =>
      provider(id, async () => {
        calls.push(id);
        return null;
      }),
    );
    assert.equal(await collectFromProviders(providers, "turn"), null);
    assert.deepEqual(calls, ["a", "b", "c"], "every provider still gets asked");
  });

  it("treats an empty or whitespace-only string as silence", async () => {
    const providers = [provider("a", async () => "   \n  "), provider("b", async () => "")];
    assert.equal(await collectFromProviders(providers, "turn"), null);
  });

  it("offers each provider a fair share of what is left", async () => {
    const seen: number[] = [];
    const providers = [
      provider("a", async (b) => {
        seen.push(b);
        return null;
      }),
      provider("b", async (b) => {
        seen.push(b);
        return null;
      }),
      provider("c", async (b) => {
        seen.push(b);
        return null;
      }),
    ];
    await collectFromProviders(providers, "turn", 300);
    // 300/3, then (nothing spent) 300/2, then 300/1 — silence donates downstream.
    assert.deepEqual(seen, [100, 150, 300]);
  });

  it("shrinks later budgets by what earlier providers actually spent", async () => {
    const seen: number[] = [];
    const providers = [
      provider("a", async (b) => {
        seen.push(b);
        return "x".repeat(90);
      }),
      provider("b", async (b) => {
        seen.push(b);
        return null;
      }),
      provider("c", async (b) => {
        seen.push(b);
        return null;
      }),
    ];
    await collectFromProviders(providers, "turn", 300);
    // 300/3 = 100 (spends 90); then 210 left minus the 2-char joiner now needed,
    // 208/2 = 104; then 208/1 = 208.
    assert.deepEqual(seen, [100, 104, 208]);
  });

  it("never lets the total exceed the cap, however greedy the extensions", async () => {
    const providers = ["a", "b", "c", "d"].map((id) =>
      provider(id, async (budget) => "x".repeat(budget)),
    );
    const out = await collectFromProviders(providers, "turn", 400);
    assert.ok(out);
    // The cap must hold on the string actually handed to the mind, joiners included —
    // not merely on the sum of the blocks inside it.
    assert.ok(out.length <= 400, `returned ${out.length} chars, cap was 400`);
  });

  it("counts the block separators against the total, not just the blocks", async () => {
    // Three providers that each take exactly their offered share: if the "\n\n" joiners
    // were free, the result would overshoot the cap by 2 chars per extra block.
    const providers = ["a", "b", "c"].map((id) =>
      provider(id, async (budget) => "x".repeat(budget)),
    );
    const out = await collectFromProviders(providers, "turn", 90);
    assert.ok(out);
    assert.ok(out.length <= 90, `returned ${out.length} chars, cap was 90`);
  });

  it("one greedy extension cannot starve the others", async () => {
    const { entry: greedy } = sized("a", 10_000);
    const modest = provider("b", async () => "b-said-something");
    const out = await collectFromProviders([greedy, modest], "turn", 400);
    // The greedy one is dropped for overrunning; the modest one still gets through.
    assert.equal(out, "b-said-something");
  });
});

describe("collectFromProviders — failure containment", () => {
  it("drops an extension that returns more than its budget, keeping the rest", async () => {
    const providers = [
      provider("over", async (b) => "x".repeat(b + 1)),
      provider("fine", async () => "kept"),
    ];
    assert.equal(await collectFromProviders(providers, "turn", 200), "kept");
  });

  it("drops an extension that throws, keeping the rest", async () => {
    const providers = [
      provider("boom", async () => {
        throw new Error("nope");
      }),
      provider("fine", async () => "kept"),
    ];
    assert.equal(await collectFromProviders(providers, "turn", 200), "kept");
  });

  it("drops an extension that throws synchronously", async () => {
    const providers = [
      {
        id: "sync-boom",
        run: (() => {
          throw new Error("sync nope");
        }) as (budget: number) => Promise<string | null>,
      },
      provider("fine", async () => "kept"),
    ];
    assert.equal(await collectFromProviders(providers, "turn", 200), "kept");
  });

  it("drops an extension that hangs, and still returns within the deadline", async () => {
    const providers = [
      provider("hang", () => new Promise(() => {})),
      provider("fine", async () => "kept"),
    ];
    const started = Date.now();
    const out = await collectFromProviders(providers, "turn", 200);
    assert.equal(out, "kept");
    assert.ok(Date.now() - started < 3000, "a hanging extension must not stall the turn");
  });

  it("tolerates a provider that returns a non-string", async () => {
    const providers = [
      { id: "weird", run: (async () => 42) as unknown as (b: number) => Promise<string | null> },
      provider("fine", async () => "kept"),
    ];
    assert.equal(await collectFromProviders(providers, "turn", 200), "kept");
  });

  it("stops asking once the overall deadline has passed", async () => {
    let clock = 0;
    const asked: string[] = [];
    const providers = ["a", "b", "c"].map((id) =>
      provider(id, async () => {
        asked.push(id);
        clock += 5000; // each call blows past the total deadline
        return null;
      }),
    );
    await collectFromProviders(providers, "turn", 300, () => clock);
    assert.deepEqual(asked, ["a"], "later providers must not be asked after the deadline");
  });
});

describe("turn context budgets", () => {
  it("spends less per turn than at wake", () => {
    assert.ok(
      TURN_CONTEXT_BUDGET.turn < TURN_CONTEXT_BUDGET.wake,
      "the per-turn budget is paid on every turn and must be the smaller one",
    );
  });

  it("keeps the per-turn budget small enough not to dominate a context window", () => {
    // ~4 chars/token: this is a hard ceiling on a cost every single turn pays.
    assert.ok(TURN_CONTEXT_BUDGET.turn <= 2000, "per-turn context must stay under ~500 tokens");
  });
});

describe("collectTurnContext — extension registry integration", () => {
  afterEach(() => {
    _clearLoadedExtensionsForTest();
  });

  function manifest(id: string, turnContext?: ExtensionManifest["turnContext"]) {
    return {
      id,
      name: id,
      version: "0.0.0",
      routes: () => ({}) as never,
      turnContext,
    } satisfies ExtensionManifest;
  }

  it("ignores extensions that do not declare turnContext", () => {
    _registerExtensionForTest(manifest("plain"));
    _registerExtensionForTest(manifest("talker", async () => "hi"));
    assert.deepEqual(
      getTurnContextProviders().map((p) => p.id),
      ["talker"],
    );
  });

  it("orders providers by id, not by load order", () => {
    _registerExtensionForTest(manifest("zebra", async () => null));
    _registerExtensionForTest(manifest("aardvark", async () => null));
    assert.deepEqual(
      getTurnContextProviders().map((p) => p.id),
      ["aardvark", "zebra"],
    );
  });

  it("returns null when no extension is loaded at all", async () => {
    assert.equal(await collectTurnContext("somemind", "turn"), null);
  });

  it("passes the mind name and reason through to the extension", async () => {
    const seen: { mind: string; reason: string; budget: number }[] = [];
    _registerExtensionForTest(
      manifest("spy", async (mindName, _ctx, opts) => {
        seen.push({ mind: mindName, reason: opts.reason, budget: opts.budget });
        return "something is around";
      }),
    );
    const out = await collectTurnContext("lyra", "wake");
    assert.equal(out, "something is around");
    assert.deepEqual(seen, [{ mind: "lyra", reason: "wake", budget: TURN_CONTEXT_BUDGET.wake }]);
  });

  it("never throws even if the registry itself misbehaves", async () => {
    // The wake caller (SleepManager.initiateWake) has no catch around this: an escape
    // would skip markAwake() and leave a mind running but never marked awake.
    const manifestWithBadId = manifest("bad", async () => null) as ExtensionManifest;
    Object.defineProperty(manifestWithBadId, "id", {
      get() {
        throw new Error("registry blew up");
      },
    });
    _registerExtensionForTest(manifestWithBadId);
    assert.equal(await collectTurnContext("lyra", "wake"), null);
  });

  it("never propagates an extension failure to the mind's turn", async () => {
    _registerExtensionForTest(
      manifest("broken", async () => {
        throw new Error("extension is broken");
      }),
    );
    assert.equal(await collectTurnContext("lyra", "turn"), null);
  });
});
