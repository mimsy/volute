import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import {
  addVariant,
  findVariant,
  readVariants,
  removeVariant,
  type Variant,
  validateBranchName,
  writeVariants,
} from "../src/lib/variants.js";

const tmpDir = join(import.meta.dirname, ".tmp-test");

function makeVariant(name: string, overrides?: Partial<Variant>): Variant {
  return {
    name,
    branch: name,
    path: `/fake/${name}`,
    port: 0,
    pid: null,
    created: new Date().toISOString(),
    ...overrides,
  };
}

describe("variants CRUD", () => {
  beforeEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });
  });

  it("readVariants returns empty array when no file", () => {
    assert.deepStrictEqual(readVariants(tmpDir), []);
  });

  it("writeVariants + readVariants roundtrips", () => {
    const v = makeVariant("test1");
    writeVariants(tmpDir, [v]);
    const result = readVariants(tmpDir);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "test1");
  });

  it("addVariant appends to list", () => {
    addVariant(tmpDir, makeVariant("a"));
    addVariant(tmpDir, makeVariant("b"));
    const result = readVariants(tmpDir);
    assert.equal(result.length, 2);
    assert.equal(result[0].name, "a");
    assert.equal(result[1].name, "b");
  });

  it("addVariant replaces existing entry with same name", () => {
    addVariant(tmpDir, makeVariant("a", { port: 1000 }));
    addVariant(tmpDir, makeVariant("a", { port: 2000 }));
    const result = readVariants(tmpDir);
    assert.equal(result.length, 1);
    assert.equal(result[0].port, 2000);
  });

  it("removeVariant removes by name", () => {
    addVariant(tmpDir, makeVariant("a"));
    addVariant(tmpDir, makeVariant("b"));
    removeVariant(tmpDir, "a");
    const result = readVariants(tmpDir);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "b");
  });

  it("removeVariant is a no-op for nonexistent name", () => {
    addVariant(tmpDir, makeVariant("a"));
    removeVariant(tmpDir, "nonexistent");
    assert.equal(readVariants(tmpDir).length, 1);
  });

  it("findVariant returns matching variant", () => {
    addVariant(tmpDir, makeVariant("target", { port: 5555 }));
    const found = findVariant(tmpDir, "target");
    assert.equal(found?.port, 5555);
  });

  it("findVariant returns undefined for missing", () => {
    assert.equal(findVariant(tmpDir, "nope"), undefined);
  });
});

describe("validateBranchName", () => {
  it("accepts valid names", () => {
    assert.equal(validateBranchName("feature-1"), null);
    assert.equal(validateBranchName("my/branch"), null);
    assert.equal(validateBranchName("v1.0.0"), null);
    assert.equal(validateBranchName("under_score"), null);
  });

  it("rejects names with special characters", () => {
    assert.notEqual(validateBranchName("foo bar"), null);
    assert.notEqual(validateBranchName("foo;rm -rf"), null);
    assert.notEqual(validateBranchName("$(evil)"), null);
  });

  it("rejects names with ..", () => {
    assert.notEqual(validateBranchName("foo..bar"), null);
  });
});
