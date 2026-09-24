import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crossSeam } from "../templates/claude/src/lib/seam.js";

/** A seed that resolves only when released — the recollection fetch in flight. */
function pending<T>() {
  let release!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    release = r;
  });
  return { promise, release };
}

describe("crossSeam", () => {
  it("a shutdown during the fetch starts nothing and points at nothing", async () => {
    for (const seed of ["restored", "cold"] as const) {
      let closed = false;
      const saved: string[] = [];
      const restore = pending<{
        sessionId: string;
        archivedAt: number | null;
        recallEntries: number;
      } | null>();
      const cold = pending<{ sessionId: string; recallEntries: number } | null>();
      const crossing = crossSeam({
        seed,
        liveSessionId: "live",
        restore: () => restore.promise,
        coldReset: () => cold.promise,
        save: (id) => saved.push(id),
        isClosed: () => closed,
      });
      closed = true; // reapAllSessions runs while the seed awaits recollection
      restore.release({ sessionId: "seeded", archivedAt: null, recallEntries: 1 });
      cold.release({ sessionId: "seeded", recallEntries: 1 });
      assert.deepEqual(await crossing, { kind: "closed" });
      assert.deepEqual(saved, []);
    }
  });

  it("a cold reset that can't seed resumes the live session", async () => {
    const saved: string[] = [];
    const outcome = await crossSeam({
      seed: "cold",
      liveSessionId: "live",
      restore: async () => null,
      coldReset: async () => null,
      save: (id) => saved.push(id),
      isClosed: () => false,
    });
    assert.deepEqual(outcome, { kind: "none" });
    assert.deepEqual(saved, []);
  });

  it("a cold reset measures the note's gap from last activity, and says whether it recalled", async () => {
    const outcome = await crossSeam({
      seed: "cold",
      liveSessionId: "live",
      lastActivityAt: 1234,
      restore: async () => null,
      coldReset: async () => ({ sessionId: "fresh", recallEntries: 0 }),
      save: () => {},
      isClosed: () => false,
    });
    assert.deepEqual(outcome, {
      kind: "seeded",
      sessionId: "fresh",
      cause: "cold",
      gapFrom: 1234,
      recalled: false,
    });
  });

  it("lets a failing pointer write reach the caller's error handling", async () => {
    await assert.rejects(
      crossSeam({
        seed: "restored",
        restore: async () => ({ sessionId: "s", archivedAt: null, recallEntries: 0 }),
        coldReset: async () => null,
        save: () => {
          throw new Error("disk full");
        },
        isClosed: () => false,
      }),
      /disk full/,
    );
  });
});
