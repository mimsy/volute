import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  addVariant,
  findVariant,
  getAllRunningVariants,
  readVariants,
  removeAllVariants,
  removeVariant,
  setVariantRunning,
  type Variant,
  validateBranchName,
  writeVariants,
} from "../src/lib/variants.js";

const testMind = `test-mind-${Date.now()}`;

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
  afterEach(() => {
    removeAllVariants(testMind);
  });

  it("readVariants returns empty array when no entries", () => {
    assert.deepStrictEqual(readVariants(testMind), []);
  });

  it("writeVariants + readVariants roundtrips", () => {
    const v = makeVariant("test1");
    writeVariants(testMind, [v]);
    const result = readVariants(testMind);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "test1");
  });

  it("addVariant appends to list", () => {
    addVariant(testMind, makeVariant("a"));
    addVariant(testMind, makeVariant("b"));
    const result = readVariants(testMind);
    assert.equal(result.length, 2);
    assert.equal(result[0].name, "a");
    assert.equal(result[1].name, "b");
  });

  it("addVariant replaces existing entry with same name", () => {
    addVariant(testMind, makeVariant("a", { port: 1000 }));
    addVariant(testMind, makeVariant("a", { port: 2000 }));
    const result = readVariants(testMind);
    assert.equal(result.length, 1);
    assert.equal(result[0].port, 2000);
  });

  it("removeVariant removes by name", () => {
    addVariant(testMind, makeVariant("a"));
    addVariant(testMind, makeVariant("b"));
    removeVariant(testMind, "a");
    const result = readVariants(testMind);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "b");
  });

  it("removeVariant is a no-op for nonexistent name", () => {
    addVariant(testMind, makeVariant("a"));
    removeVariant(testMind, "nonexistent");
    assert.equal(readVariants(testMind).length, 1);
  });

  it("findVariant returns matching variant", () => {
    addVariant(testMind, makeVariant("target", { port: 5555 }));
    const found = findVariant(testMind, "target");
    assert.equal(found?.port, 5555);
  });

  it("findVariant returns undefined for missing", () => {
    assert.equal(findVariant(testMind, "nope"), undefined);
  });

  it("removeAllVariants clears all entries for mind", () => {
    addVariant(testMind, makeVariant("a"));
    addVariant(testMind, makeVariant("b"));
    removeAllVariants(testMind);
    assert.deepStrictEqual(readVariants(testMind), []);
  });
});

describe("variant running state", () => {
  afterEach(() => {
    removeAllVariants(testMind);
  });

  it("setVariantRunning sets running to true", () => {
    addVariant(testMind, makeVariant("a"));
    setVariantRunning(testMind, "a", true);
    const v = findVariant(testMind, "a");
    assert.equal(v?.running, true);
  });

  it("setVariantRunning sets running to false", () => {
    addVariant(testMind, makeVariant("a", { running: true }));
    setVariantRunning(testMind, "a", false);
    const v = findVariant(testMind, "a");
    assert.equal(v?.running, false);
  });

  it("setVariantRunning is no-op for nonexistent variant", () => {
    addVariant(testMind, makeVariant("a"));
    setVariantRunning(testMind, "nonexistent", true);
    const v = findVariant(testMind, "a");
    assert.equal(v?.running, undefined);
  });

  it("getAllRunningVariants returns running variants", () => {
    addVariant(testMind, makeVariant("a", { running: true }));
    addVariant(testMind, makeVariant("b", { running: false }));
    addVariant(testMind, makeVariant("c", { running: true }));
    const running = getAllRunningVariants();
    const forMind = running.filter((r) => r.mindName === testMind);
    assert.equal(forMind.length, 2);
    const names = forMind.map((r) => r.variant.name).sort();
    assert.deepStrictEqual(names, ["a", "c"]);
  });

  it("getAllRunningVariants returns empty when none running", () => {
    addVariant(testMind, makeVariant("a"));
    const running = getAllRunningVariants();
    const forMind = running.filter((r) => r.mindName === testMind);
    assert.equal(forMind.length, 0);
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
