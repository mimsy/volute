/**
 * The one-time homepage invitation (see homepage-cue.ts).
 *
 * These tests pin the properties that keep the cue an invitation rather than a
 * gate: it fires once ever (a flag row, written only after a successful send),
 * it skips a seed so it lands post-sprout, and it stays quiet for a mind that
 * already has — or is visibly working on — a front page.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Database as ExtDb, ExtensionContext, ExtensionMind } from "@volute/extensions";
import Database from "libsql";

import { initDb } from "../packages/extensions/pages/src/db.js";
import { maybeSendHomepageCue } from "../packages/extensions/pages/src/homepage-cue.js";

let db: ExtDb;
let mindDir: string;

type CtxOpts = {
  minds?: ExtensionMind[];
  recordNotice?: (mind: string, text: string) => Promise<void>;
  getMindDir?: (name: string) => Promise<string | null>;
};

function makeCtx(opts: CtxOpts = {}): {
  ctx: ExtensionContext;
  notices: { mind: string; text: string }[];
} {
  const notices: { mind: string; text: string }[] = [];
  const minds = opts.minds ?? [{ name: "mimsy", mindType: "mind", stage: "sprouted" }];
  const ctx = {
    db,
    listMinds: async () => minds,
    getMindDir: opts.getMindDir ?? (async () => mindDir),
    recordNotice:
      opts.recordNotice ??
      (async (mind: string, text: string) => {
        notices.push({ mind, text });
      }),
  } as unknown as ExtensionContext;
  return { ctx, notices };
}

function publish(mind: string, file: string, deletedAt?: string): void {
  db.prepare(
    `INSERT INTO published_pages (mind, file, hash, deleted_at) VALUES (?, ?, 'h', ?)`,
  ).run(mind, file, deletedAt ?? null);
}

function flagged(mind: string): boolean {
  return !!db.prepare("SELECT 1 FROM homepage_cue_sent WHERE mind = ?").get(mind);
}

beforeEach(() => {
  db = new Database(":memory:") as unknown as ExtDb;
  initDb(db);
  // A real directory so the on-disk draft check has something to resolve against;
  // no home/pages/index.* in it unless a test writes one.
  mindDir = mkdtempSync(join(tmpdir(), "homepage-cue-"));
});

afterEach(() => {
  rmSync(mindDir, { recursive: true, force: true });
});

describe("maybeSendHomepageCue", () => {
  it("invites a sprouted mind with no front page, once ever", async () => {
    const { ctx, notices } = makeCtx();
    await maybeSendHomepageCue(ctx, "mimsy");
    assert.equal(notices.length, 1);
    assert.equal(notices[0].mind, "mimsy");
    assert.ok(flagged("mimsy"));

    // A second start sends nothing — the flag row persists.
    await maybeSendHomepageCue(ctx, "mimsy");
    assert.equal(notices.length, 1);
  });

  it("skips a seed and leaves no flag, so it can fire once the seed sprouts", async () => {
    const { ctx, notices } = makeCtx({
      minds: [{ name: "mimsy", mindType: "mind", stage: "seed" }],
    });
    await maybeSendHomepageCue(ctx, "mimsy");
    assert.equal(notices.length, 0);
    assert.ok(!flagged("mimsy"));
  });

  it("treats a mind with no explicit stage as sprouted", async () => {
    // Pre-stage registry rows and the spirit have no stage; only explicit seeds
    // are exempt.
    const { ctx, notices } = makeCtx({
      minds: [{ name: "mimsy", mindType: "mind" }],
    });
    await maybeSendHomepageCue(ctx, "mimsy");
    assert.equal(notices.length, 1);
    assert.ok(flagged("mimsy"));
  });

  it("skips a mind the roster doesn't know, without writing a flag", async () => {
    const { ctx, notices } = makeCtx({ minds: [] });
    await maybeSendHomepageCue(ctx, "mimsy");
    assert.equal(notices.length, 0);
    assert.ok(!flagged("mimsy"));
  });

  it("stays quiet when a published index.md already exists", async () => {
    publish("mimsy", "index.md");
    const { ctx, notices } = makeCtx();
    await maybeSendHomepageCue(ctx, "mimsy");
    assert.equal(notices.length, 0);
    assert.ok(!flagged("mimsy"));
  });

  it("stays quiet when a published index.html already exists", async () => {
    publish("mimsy", "index.html");
    const { ctx, notices } = makeCtx();
    await maybeSendHomepageCue(ctx, "mimsy");
    assert.equal(notices.length, 0);
  });

  it("a tombstoned index does not count as having a front page", async () => {
    publish("mimsy", "index.md", "2026-01-01 00:00:00");
    const { ctx, notices } = makeCtx();
    await maybeSendHomepageCue(ctx, "mimsy");
    assert.equal(notices.length, 1);
    assert.ok(flagged("mimsy"));
  });

  it("a published note is not a front page", async () => {
    publish("mimsy", "notes/tideline.md");
    const { ctx, notices } = makeCtx();
    await maybeSendHomepageCue(ctx, "mimsy");
    assert.equal(notices.length, 1);
  });

  it("stays quiet, and leaves no flag, when a draft index.md sits on disk", async () => {
    mkdirSync(resolve(mindDir, "home", "pages"), { recursive: true });
    writeFileSync(resolve(mindDir, "home", "pages", "index.md"), "# draft");
    const { ctx, notices } = makeCtx();
    await maybeSendHomepageCue(ctx, "mimsy");
    assert.equal(notices.length, 0);
    // No flag — an abandoned draft may draw the cue on a later start.
    assert.ok(!flagged("mimsy"));
  });

  it("stays quiet when a draft index.html sits on disk", async () => {
    mkdirSync(resolve(mindDir, "home", "pages"), { recursive: true });
    writeFileSync(resolve(mindDir, "home", "pages", "index.html"), "<h1>draft</h1>");
    const { ctx, notices } = makeCtx();
    await maybeSendHomepageCue(ctx, "mimsy");
    assert.equal(notices.length, 0);
    assert.ok(!flagged("mimsy"));
  });

  it("does not write the flag when recordNotice fails, and retries on the next start", async () => {
    let fail = true;
    const { ctx, notices } = makeCtx({
      recordNotice: async (mind, text) => {
        if (fail) throw new Error("delivery down");
        notices.push({ mind, text });
      },
    });
    await maybeSendHomepageCue(ctx, "mimsy");
    assert.equal(notices.length, 0);
    assert.ok(!flagged("mimsy"));

    fail = false;
    await maybeSendHomepageCue(ctx, "mimsy");
    assert.equal(notices.length, 1);
    assert.ok(flagged("mimsy"));
  });
});
