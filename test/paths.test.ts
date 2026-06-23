import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  PathTraversalError,
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
