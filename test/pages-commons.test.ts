import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { commonsReport, maybeSendCommonsCue } from "../packages/extensions/pages/src/commons.js";
import type { ExtensionContext, User } from "../packages/extensions/sdk/src/types.js";

describe("commonsReport", () => {
  let dir: string;
  let dir2: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "commons-report-"));
    dir2 = mkdtempSync(join(tmpdir(), "commons-report-2-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  });

  it("walks reachability from the index and reports orphans", () => {
    writeFileSync(
      resolve(dir, "index.md"),
      "see [lore](garden/lore.md) and [alpha's site](../alpha/)",
    );
    mkdirSync(resolve(dir, "garden"), { recursive: true });
    writeFileSync(resolve(dir, "garden", "lore.md"), "links onward to [songs](songs.md)");
    writeFileSync(resolve(dir, "songs.md"), "");
    writeFileSync(resolve(dir, "stray.md"), "nobody links me");

    const r = commonsReport(
      dir,
      ["index.md", "garden/lore.md", "songs.md", "stray.md"],
      ["alpha", "beta"],
    );
    assert.equal(r.hasIndex, true);
    assert.deepEqual(r.orphanPages, ["stray.md"]);
    assert.deepEqual(r.unlinkedMinds, ["beta"]);
  });

  it("no index means everything is orphaned", () => {
    writeFileSync(resolve(dir2, "a.md"), "hello");
    const r = commonsReport(dir2, ["a.md"], ["alpha"]);
    assert.equal(r.hasIndex, false);
    assert.deepEqual(r.orphanPages, ["a.md"]);
    assert.deepEqual(r.unlinkedMinds, ["alpha"]);
  });

  it("no orphans and no unlinked minds when everything is reachable and linked", () => {
    writeFileSync(resolve(dir, "index.md"), "see [about](about.md) and [alpha](../alpha/)");
    writeFileSync(resolve(dir, "about.md"), "nothing more");
    const r = commonsReport(dir, ["index.md", "about.md"], ["alpha"]);
    assert.equal(r.hasIndex, true);
    assert.deepEqual(r.orphanPages, []);
    assert.deepEqual(r.unlinkedMinds, []);
  });

  it("recognizes mind links via the public iframe URL form too", () => {
    writeFileSync(resolve(dir, "index.md"), "see [alpha](/ext/pages/public/alpha/index.html)");
    const r = commonsReport(dir, ["index.md"], ["alpha"]);
    assert.deepEqual(r.unlinkedMinds, []);
  });
});

describe("maybeSendCommonsCue", () => {
  let dataDir: string;
  let repoDir: string;

  function makeCtx(overrides: Partial<ExtensionContext> = {}): {
    ctx: ExtensionContext;
    notices: { mind: string; text: string }[];
  } {
    const notices: { mind: string; text: string }[] = [];
    const ctx = {
      db: null,
      authMiddleware: (() => {}) as any,
      requireSelf: (() => () => {}) as any,
      resolveUser: () => null,
      getUser: async () => null,
      getUserByUsername: async (username: string) =>
        ({ id: 1, username, role: "user", user_type: "mind" }) as User,
      publishActivity: () => {},
      getMindDir: async () => "/spirit/dir",
      getSystemsConfig: () => null,
      announceToSystem: async () => {},
      recordNotice: async (mind: string, text: string) => {
        notices.push({ mind, text });
      },
      isIsolationEnabled: () => false,
      getMindUser: (name: string) => `mind-${name}`,
      getSpiritName: () => "aria",
      dataDir,
      ...overrides,
    } as ExtensionContext;
    return { ctx, notices };
  }

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "commons-cue-"));
    repoDir = resolve(dataDir, "repo");
    mkdirSync(repoDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("sends a notice to the spirit and writes the flag when there's no index", async () => {
    const { ctx, notices } = makeCtx();
    await maybeSendCommonsCue(ctx, repoDir);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].mind, "aria");
    assert.ok(existsSync(resolve(dataDir, ".commons-cue-sent")));
  });

  it("does not re-send once the flag is present", async () => {
    const { ctx, notices } = makeCtx();
    await maybeSendCommonsCue(ctx, repoDir);
    notices.length = 0;
    await maybeSendCommonsCue(ctx, repoDir);
    assert.equal(notices.length, 0);
  });

  it("does not send when an index already exists", async () => {
    writeFileSync(resolve(repoDir, "index.md"), "# hi");
    const { ctx, notices } = makeCtx();
    await maybeSendCommonsCue(ctx, repoDir);
    assert.equal(notices.length, 0);
    assert.ok(!existsSync(resolve(dataDir, ".commons-cue-sent")));
  });

  it("does not send when there is no spirit configured", async () => {
    const { ctx, notices } = makeCtx({ getSpiritName: () => null });
    await maybeSendCommonsCue(ctx, repoDir);
    assert.equal(notices.length, 0);
    assert.ok(!existsSync(resolve(dataDir, ".commons-cue-sent")));
  });

  it("does not send or write the flag when the spirit project doesn't exist yet", async () => {
    const { ctx, notices } = makeCtx({ getMindDir: async () => null });
    await maybeSendCommonsCue(ctx, repoDir);
    assert.equal(notices.length, 0);
    assert.ok(!existsSync(resolve(dataDir, ".commons-cue-sent")));
  });

  // Regression: the spirit shares the system user account (`user_type: "system"`),
  // so gating the cue on the users table meant it never fired on any install.
  // The gate is the spirit's project existing, not what its user row says it is —
  // hence the production-shaped user row here, which fails the moment anyone
  // reintroduces a `user_type === "mind"` check (verified by reverting the fix).
  it("sends to the spirit even though its user row is user_type system", async () => {
    const { ctx, notices } = makeCtx({
      getUserByUsername: async (username: string) =>
        ({ id: 1, username, role: "system", user_type: "system" }) as unknown as User,
    });
    await maybeSendCommonsCue(ctx, repoDir);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].mind, "aria");
    assert.ok(existsSync(resolve(dataDir, ".commons-cue-sent")));
  });

  it("index.html also counts as an index", async () => {
    writeFileSync(resolve(repoDir, "index.html"), "<h1>hi</h1>");
    const { ctx, notices } = makeCtx();
    await maybeSendCommonsCue(ctx, repoDir);
    assert.equal(notices.length, 0);
  });
});
