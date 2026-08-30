import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  PathTraversalError,
  resolveRealWithinBase,
  resolveWithinBase,
  safeResolveWithinBase,
} from "../packages/daemon/src/lib/util/paths.js";

describe("resolveWithinBase", () => {
  const base = "/tmp/volute-mind/home";

  it("resolves a normal relative path within the base", () => {
    assert.equal(resolveWithinBase(base, "avatar.png"), resolve(base, "avatar.png"));
  });

  it("resolves a nested relative path within the base", () => {
    assert.equal(resolveWithinBase(base, "sub/dir/file.txt"), resolve(base, "sub/dir/file.txt"));
  });

  it("allows the base directory itself", () => {
    assert.equal(resolveWithinBase(base, "."), resolve(base));
  });

  it("throws on parent traversal that escapes the base", () => {
    assert.throws(() => resolveWithinBase(base, "../../../etc/passwd"), PathTraversalError);
  });

  it("throws on an absolute path that escapes the base", () => {
    assert.throws(() => resolveWithinBase(base, "/etc/cron.d/evil"), PathTraversalError);
  });

  it("throws on a sibling-prefix path that is not actually contained", () => {
    // /tmp/volute-mind/home-evil shares a string prefix but is NOT inside base
    assert.throws(() => resolveWithinBase(base, "../home-evil/x"), PathTraversalError);
  });

  it("throws on traversal that climbs out and back to a different tree", () => {
    assert.throws(() => resolveWithinBase(base, "foo/../../bar"), PathTraversalError);
  });

  it("permits traversal that stays within the base", () => {
    assert.equal(resolveWithinBase(base, "a/../b"), resolve(base, "b"));
  });
});

describe("safeResolveWithinBase", () => {
  const base = "/tmp/volute-mind/home";

  it("returns the contained path for valid input", () => {
    assert.equal(safeResolveWithinBase(base, "avatar.png"), resolve(base, "avatar.png"));
  });

  it("returns null instead of throwing on escape", () => {
    assert.equal(safeResolveWithinBase(base, "../../../etc/passwd"), null);
    assert.equal(safeResolveWithinBase(base, "/etc/passwd"), null);
  });
});

describe("resolveRealWithinBase", () => {
  let dir: string;
  let base: string;
  let outside: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "volute-paths-"));
    base = join(dir, "home");
    outside = join(dir, "outside");
    mkdirSync(join(base, "sub"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(base, "note.md"), "inside");
    writeFileSync(join(base, "sub", "deep.txt"), "deep");
    writeFileSync(join(outside, "secret.txt"), "SECRET");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("resolves a real file within the base", async () => {
    // realpath()'d on both sides: on macOS the tmpdir itself is behind a symlink.
    assert.equal(
      await resolveRealWithinBase(base, "note.md"),
      join(await realpath(base), "note.md"),
    );
  });

  it("resolves a nested real file within the base", async () => {
    const got = await resolveRealWithinBase(base, "sub/deep.txt");
    assert.equal(got, join(await realpath(base), "sub", "deep.txt"));
  });

  it("allows the base directory itself", async () => {
    assert.equal(await resolveRealWithinBase(base, "."), await realpath(base));
    // "" is the value files.ts actually passes for the home root.
    assert.equal(await resolveRealWithinBase(base, ""), await realpath(base));
  });

  it("rejects a symlink inside the base that points to a file outside it", async () => {
    // The lexical check passes — the link itself sits under home/ — so only
    // symlink resolution catches this. This is the case the hand-rolled
    // containment in files.ts existed to stop (#731).
    symlinkSync(join(outside, "secret.txt"), join(base, "escape.txt"));
    await assert.rejects(() => resolveRealWithinBase(base, "escape.txt"), PathTraversalError);
  });

  it("rejects a symlinked directory inside the base that points outside it", async () => {
    symlinkSync(outside, join(base, "elsewhere"));
    await assert.rejects(
      () => resolveRealWithinBase(base, "elsewhere/secret.txt"),
      PathTraversalError,
    );
  });

  it("allows a symlink inside the base that points back into the base", async () => {
    symlinkSync(join(base, "sub", "deep.txt"), join(base, "link.txt"));
    assert.equal(
      await resolveRealWithinBase(base, "link.txt"),
      join(await realpath(base), "sub", "deep.txt"),
    );
  });

  it("rejects lexical traversal before touching the filesystem", async () => {
    await assert.rejects(
      () => resolveRealWithinBase(base, "../outside/secret.txt"),
      PathTraversalError,
    );
    await assert.rejects(() => resolveRealWithinBase(base, "/etc/passwd"), PathTraversalError);
  });

  it("propagates ENOENT for a missing path rather than masking it", async () => {
    // files.ts distinguishes 403 (escape) from 404 (missing) from 500, so the
    // primitive must not swallow the error code.
    await assert.rejects(
      () => resolveRealWithinBase(base, "nope.txt"),
      (err: NodeJS.ErrnoException) => err.code === "ENOENT",
    );
  });

  it("propagates ENOENT when the base itself is missing", async () => {
    await assert.rejects(
      () => resolveRealWithinBase(join(dir, "no-such-home"), "note.md"),
      (err: NodeJS.ErrnoException) => err.code === "ENOENT",
    );
  });
});
