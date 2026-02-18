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

const testAgent = `test-agent-${Date.now()}`;

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
    removeAllVariants(testAgent);
  });

  it("readVariants returns empty array when no entries", () => {
    assert.deepStrictEqual(readVariants(testAgent), []);
  });

  it("writeVariants + readVariants roundtrips", () => {
    const v = makeVariant("test1");
    writeVariants(testAgent, [v]);
    const result = readVariants(testAgent);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "test1");
  });

  it("addVariant appends to list", () => {
    addVariant(testAgent, makeVariant("a"));
    addVariant(testAgent, makeVariant("b"));
    const result = readVariants(testAgent);
    assert.equal(result.length, 2);
    assert.equal(result[0].name, "a");
    assert.equal(result[1].name, "b");
  });

  it("addVariant replaces existing entry with same name", () => {
    addVariant(testAgent, makeVariant("a", { port: 1000 }));
    addVariant(testAgent, makeVariant("a", { port: 2000 }));
    const result = readVariants(testAgent);
    assert.equal(result.length, 1);
    assert.equal(result[0].port, 2000);
  });

  it("removeVariant removes by name", () => {
    addVariant(testAgent, makeVariant("a"));
    addVariant(testAgent, makeVariant("b"));
    removeVariant(testAgent, "a");
    const result = readVariants(testAgent);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "b");
  });

  it("removeVariant is a no-op for nonexistent name", () => {
    addVariant(testAgent, makeVariant("a"));
    removeVariant(testAgent, "nonexistent");
    assert.equal(readVariants(testAgent).length, 1);
  });

  it("findVariant returns matching variant", () => {
    addVariant(testAgent, makeVariant("target", { port: 5555 }));
    const found = findVariant(testAgent, "target");
    assert.equal(found?.port, 5555);
  });

  it("findVariant returns undefined for missing", () => {
    assert.equal(findVariant(testAgent, "nope"), undefined);
  });

  it("removeAllVariants clears all entries for agent", () => {
    addVariant(testAgent, makeVariant("a"));
    addVariant(testAgent, makeVariant("b"));
    removeAllVariants(testAgent);
    assert.deepStrictEqual(readVariants(testAgent), []);
  });
});

describe("variant running state", () => {
  afterEach(() => {
    removeAllVariants(testAgent);
  });

  it("setVariantRunning sets running to true", () => {
    addVariant(testAgent, makeVariant("a"));
    setVariantRunning(testAgent, "a", true);
    const v = findVariant(testAgent, "a");
    assert.equal(v?.running, true);
  });

  it("setVariantRunning sets running to false", () => {
    addVariant(testAgent, makeVariant("a", { running: true }));
    setVariantRunning(testAgent, "a", false);
    const v = findVariant(testAgent, "a");
    assert.equal(v?.running, false);
  });

  it("setVariantRunning is no-op for nonexistent variant", () => {
    addVariant(testAgent, makeVariant("a"));
    setVariantRunning(testAgent, "nonexistent", true);
    const v = findVariant(testAgent, "a");
    assert.equal(v?.running, undefined);
  });

  it("getAllRunningVariants returns running variants", () => {
    addVariant(testAgent, makeVariant("a", { running: true }));
    addVariant(testAgent, makeVariant("b", { running: false }));
    addVariant(testAgent, makeVariant("c", { running: true }));
    const running = getAllRunningVariants();
    const forAgent = running.filter((r) => r.mindName === testAgent);
    assert.equal(forAgent.length, 2);
    const names = forAgent.map((r) => r.variant.name).sort();
    assert.deepStrictEqual(names, ["a", "c"]);
  });

  it("getAllRunningVariants returns empty when none running", () => {
    addVariant(testAgent, makeVariant("a"));
    const running = getAllRunningVariants();
    const forAgent = running.filter((r) => r.mindName === testAgent);
    assert.equal(forAgent.length, 0);
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
