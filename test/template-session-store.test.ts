import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  composeTemplate,
  findTemplatesRoot,
} from "../packages/daemon/src/lib/template/template.js";

// session-store.ts lives in templates/claude/ but imports ./logger.js from _base, so it
// only resolves once the template is composed — the same shape a real mind runs.
let composedDir: string;
type Record_ = { sessionId: string; committed: boolean };
let createSessionStore: (dir: string) => {
  load(name: string): Record_ | undefined;
  save(name: string, id: string, committed?: boolean): void;
  delete(name: string): void;
};
let lostRealContext: (record: Record_ | undefined) => boolean;

let dir: string;

/**
 * The `committed` flag is what separates "this pointer had a conversation behind it"
 * from "this pointer was stamped when the SDK handed out an id and nothing ever
 * happened in it". Only the first is a context loss worth telling a mind about (#769).
 */
describe("claude template session store", () => {
  before(async () => {
    dir = mkdtempSync(resolve(tmpdir(), "volute-session-store-"));
    composedDir = composeTemplate(findTemplatesRoot(), "claude").composedDir;
    ({ createSessionStore, lostRealContext } = await import(
      resolve(composedDir, "src/lib/session-store.ts")
    ));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(composedDir, { recursive: true, force: true });
  });

  it("stamps a new pointer uncommitted by default", () => {
    const store = createSessionStore(dir);
    store.save("fresh", "sess-1");
    assert.deepEqual(store.load("fresh"), { sessionId: "sess-1", committed: false });
  });

  it("round-trips a committed pointer", () => {
    const store = createSessionStore(dir);
    store.save("worked", "sess-2", true);
    assert.deepEqual(store.load("worked"), { sessionId: "sess-2", committed: true });
  });

  it("reads a legacy {sessionId} file as uncommitted", () => {
    // An install upgrading into this fix carries exactly the never-turned pointers the
    // bug describes, so the absent field must not be read as "had content" — that would
    // fire the false amnesia notice once more on the first restart after the upgrade.
    writeFileSync(resolve(dir, "legacy.json"), JSON.stringify({ sessionId: "sess-old" }));
    const store = createSessionStore(dir);
    assert.deepEqual(store.load("legacy"), { sessionId: "sess-old", committed: false });
  });

  it("persists the flag to disk rather than only in memory", () => {
    createSessionStore(dir).save("durable", "sess-3", true);
    // A different store instance is the realistic case: the flag has to survive the
    // process restart that reads it back.
    assert.equal(createSessionStore(dir).load("durable")?.committed, true);
    assert.deepEqual(JSON.parse(readFileSync(resolve(dir, "durable.json"), "utf-8")), {
      sessionId: "sess-3",
      committed: true,
    });
  });

  it("clears the flag with the pointer on delete", () => {
    const store = createSessionStore(dir);
    store.save("gone", "sess-4", true);
    store.delete("gone");
    assert.equal(store.load("gone"), undefined);
    // A reset session starts over uncommitted — nothing to lose until it earns it.
    store.save("gone", "sess-5");
    assert.equal(store.load("gone")?.committed, false);
  });

  it("ignores a corrupt or shapeless file rather than throwing", () => {
    writeFileSync(resolve(dir, "broken.json"), "{not json");
    writeFileSync(resolve(dir, "shapeless.json"), JSON.stringify({ committed: true }));
    const store = createSessionStore(dir);
    assert.equal(store.load("broken"), undefined);
    assert.equal(store.load("shapeless"), undefined);
    assert.equal(store.load("never-existed"), undefined);
  });

  it("lostRealContext answers both directions, not just the safe one", () => {
    const store = createSessionStore(dir);

    // #769: a pointer stamped when the SDK handed out an id, with no turn behind it.
    // Its transcript going missing is an ordinary restart, not amnesia.
    store.save("never-spoke", "sess-a");
    assert.equal(lostRealContext(store.load("never-spoke")), false);

    // #367, the hard constraint: a session that carried conversation and is now gone
    // must still be reported. Silencing this to kill the false positive is not a fix.
    store.save("spoke", "sess-b", true);
    assert.equal(lostRealContext(store.load("spoke")), true);

    // No pointer at all is not a loss either — there was nothing to lose.
    assert.equal(lostRealContext(store.load("no-such-session")), false);
    assert.equal(lostRealContext(undefined), false);
  });
});
