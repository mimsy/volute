import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { broadcast } from "../packages/daemon/src/lib/events/activity-events.js";
import {
  FAREWELL_MIND_PATH,
  FAREWELL_RELPATH,
  farewellPath,
  readFarewell,
  runFarewellTurn,
} from "../packages/daemon/src/lib/mind/farewell.js";

/** Start a throwaway HTTP server; returns its port and a close fn. */
async function stubServer(onRequest: () => void): Promise<{ port: number; close: () => void }> {
  const server: Server = createServer((_req, res) => {
    onRequest();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { port, close: () => server.close() };
}

/** Allocate then release a port so nothing is listening on it (ECONNREFUSED). */
async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

describe("farewell notes", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "farewell-"));
    mkdirSync(resolve(dir, ".mind"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("readFarewell returns trimmed content when the note exists", () => {
    writeFileSync(farewellPath(dir), "\n  I learned to be patient.  \n");
    assert.equal(readFarewell(dir), "I learned to be patient.");
  });

  it("readFarewell returns undefined when the note is absent", () => {
    assert.equal(readFarewell(dir), undefined);
  });

  it("readFarewell treats a whitespace-only note as absent", () => {
    writeFileSync(farewellPath(dir), "   \n\t\n");
    assert.equal(readFarewell(dir), undefined);
  });

  it("runFarewellTurn surfaces an existing note when the variant isn't running", async () => {
    writeFileSync(farewellPath(dir), "Goodbye.");
    const note = await runFarewellTurn({
      variantName: "v",
      parentName: "p",
      variantDir: dir,
      port: 0,
      running: false,
    });
    assert.equal(note, "Goodbye.");
  });

  it("runFarewellTurn returns undefined with no note and no running server", async () => {
    const note = await runFarewellTurn({
      variantName: "v",
      parentName: "p",
      variantDir: dir,
      port: 0,
      running: false,
    });
    assert.equal(note, undefined);
  });

  it("FAREWELL_RELPATH lives under .mind so it never lands in the parent tree", () => {
    assert.ok(FAREWELL_RELPATH.startsWith(".mind/"));
  });

  it("the path told to the mind resolves to the same file the daemon reads", () => {
    // Contract: the daemon reads FAREWELL_RELPATH from the variant project root,
    // but the mind's SDK runs with cwd home/ — so the path in the prompt must be
    // FAREWELL_MIND_PATH, resolved from home/, landing on the same file. If
    // either end drifts, every live farewell is silently written where the other
    // never looks.
    const fromMind = resolve(dir, "home", FAREWELL_MIND_PATH);
    assert.equal(fromMind, farewellPath(dir));
  });
});

// The live-turn (running: true) path. Delivery is a plain fetch to the mind's
// port, and idle detection is in-process activity events — so a stub HTTP
// server plus a broadcast() cover the load-bearing behaviors without a real
// mind. Only the mind actually composing a note needs a real turn.
describe("runFarewellTurn live turn", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "farewell-live-"));
    mkdirSync(resolve(dir, ".mind"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("proceeds after the timeout when the variant never goes idle (hard requirement)", async () => {
    // Delivery succeeds but no mind_done/mind_idle ever fires — a variant stuck
    // mid-thought. The join must not hang: it proceeds once the timeout elapses.
    const server = await stubServer(() => {});
    try {
      const start = Date.now();
      const note = await runFarewellTurn({
        variantName: "stuck",
        parentName: "p",
        variantDir: dir,
        port: server.port,
        running: true,
        timeoutMs: 200,
      });
      const elapsed = Date.now() - start;
      assert.equal(note, undefined, "no note was written");
      assert.ok(elapsed >= 150, `should wait for the timeout, waited ${elapsed}ms`);
      assert.ok(elapsed < 3000, `should proceed shortly after the timeout, waited ${elapsed}ms`);
    } finally {
      server.close();
    }
  });

  it("returns quickly when the note is written and the variant goes idle", async () => {
    // On delivery, the "mind" writes its note and goes idle. The turn should
    // resolve promptly (timer cancelled), well under the timeout, with the note.
    const server = await stubServer(() => {
      writeFileSync(farewellPath(dir), "It was brief, but it was mine.\n");
      broadcast({ type: "mind_done", mind: "swift", summary: "" });
    });
    try {
      const start = Date.now();
      const note = await runFarewellTurn({
        variantName: "swift",
        parentName: "p",
        variantDir: dir,
        port: server.port,
        running: true,
        timeoutMs: 10_000,
      });
      const elapsed = Date.now() - start;
      assert.equal(note, "It was brief, but it was mine.");
      assert.ok(elapsed < 3000, `should not wait for the full timeout, waited ${elapsed}ms`);
    } finally {
      server.close();
    }
  });

  it("waits past an unrelated in-flight turn's idle event and still captures the note", async () => {
    // The variant already has an unrelated turn in flight when we deliver: its
    // idle event fires first with no note. The farewell turn then writes the
    // note and goes idle. We must return the note, not the premature undefined.
    const server = await stubServer(() => {
      broadcast({ type: "mind_done", mind: "racy", summary: "" }); // unrelated turn
      setTimeout(() => {
        writeFileSync(farewellPath(dir), "The second event is the real one.\n");
        broadcast({ type: "mind_done", mind: "racy", summary: "" }); // farewell turn
      }, 50);
    });
    try {
      const note = await runFarewellTurn({
        variantName: "racy",
        parentName: "p",
        variantDir: dir,
        port: server.port,
        running: true,
        timeoutMs: 10_000,
      });
      assert.equal(note, "The second event is the real one.");
    } finally {
      server.close();
    }
  });

  it("treats a non-2xx delivery response as a failure and short-circuits", async () => {
    // The variant's server answered but rejected the turn (e.g. 503). We must
    // not sit through the full idle timeout waiting for a turn that never runs.
    const server = createServer((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const start = Date.now();
      const note = await runFarewellTurn({
        variantName: "rejected",
        parentName: "p",
        variantDir: dir,
        port,
        running: true,
        timeoutMs: 10_000,
      });
      const elapsed = Date.now() - start;
      assert.equal(note, undefined);
      assert.ok(elapsed < 5000, `non-2xx should return fast, waited ${elapsed}ms`);
    } finally {
      server.close();
    }
  });

  it("short-circuits the wait when delivery fails (does not burn the timeout)", async () => {
    const port = await deadPort();
    const start = Date.now();
    const note = await runFarewellTurn({
      variantName: "unreachable",
      parentName: "p",
      variantDir: dir,
      port,
      running: true,
      timeoutMs: 10_000,
    });
    const elapsed = Date.now() - start;
    assert.equal(note, undefined);
    assert.ok(elapsed < 5000, `undelivered turn should return fast, waited ${elapsed}ms`);
  });

  it("clears a stale note before a live turn so it isn't folded into an unrelated merge", async () => {
    // A note left by an aborted prior join must not leak. Here the turn can't be
    // delivered (dead port) and writes nothing, so a genuine absence must result.
    writeFileSync(farewellPath(dir), "stale words from a previous join");
    const port = await deadPort();
    const note = await runFarewellTurn({
      variantName: "stale",
      parentName: "p",
      variantDir: dir,
      port,
      running: true,
      timeoutMs: 200,
    });
    assert.equal(note, undefined, "stale note should be cleared, not returned");
  });
});
