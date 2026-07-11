import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadJsonMap, saveJsonMap } from "../packages/daemon/src/lib/util/json-state.js";

describe("loadJsonMap", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "json-state-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty map when the file is missing", () => {
    const map = loadJsonMap(join(dir, "missing.json"));
    assert.equal(map.size, 0);
  });

  it("returns an empty map for a zero-length file without throwing", () => {
    const path = join(dir, "empty.json");
    writeFileSync(path, "");
    // An empty file is an expected condition (fresh install), not a parse error.
    const map = loadJsonMap(path);
    assert.equal(map.size, 0);
  });

  it("returns an empty map for a whitespace-only file", () => {
    const path = join(dir, "blank.json");
    writeFileSync(path, "  \n\t ");
    const map = loadJsonMap(path);
    assert.equal(map.size, 0);
  });

  it("loads numeric entries and skips non-numeric values", () => {
    const path = join(dir, "state.json");
    writeFileSync(path, JSON.stringify({ a: 1, b: 2, c: "nope" }));
    const map = loadJsonMap(path);
    assert.equal(map.size, 2);
    assert.equal(map.get("a"), 1);
    assert.equal(map.get("b"), 2);
    assert.equal(map.has("c"), false);
  });

  it("recovers to an empty map on corrupt JSON", () => {
    const path = join(dir, "corrupt.json");
    writeFileSync(path, "{not valid json");
    const map = loadJsonMap(path);
    assert.equal(map.size, 0);
  });

  it("round-trips through saveJsonMap", () => {
    const path = join(dir, "roundtrip.json");
    const original = new Map([
      ["x", 10],
      ["y", 20],
    ]);
    saveJsonMap(path, original);
    const loaded = loadJsonMap(path);
    assert.deepEqual([...loaded.entries()].sort(), [
      ["x", 10],
      ["y", 20],
    ]);
  });
});
