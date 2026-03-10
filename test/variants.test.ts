import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  addMind,
  addSplit,
  findMind,
  findSplits,
  getBaseName,
  readAllMinds,
  removeMind,
  setMindRunning,
} from "../src/lib/registry.js";
import { validateBranchName } from "../src/lib/variants.js";

const testMind = `test-mind-${Date.now()}`;

describe("splits CRUD", () => {
  afterEach(() => {
    try {
      removeMind(testMind);
    } catch {}
  });

  it("findSplits returns empty array when no splits", () => {
    addMind(testMind, 4200);
    assert.deepStrictEqual(findSplits(testMind), []);
  });

  it("addSplit creates a split linked to parent", () => {
    addMind(testMind, 4200);
    addSplit(`${testMind}-a`, testMind, 4201, "/fake/a", "branch-a");
    const splits = findSplits(testMind);
    assert.equal(splits.length, 1);
    assert.equal(splits[0].name, `${testMind}-a`);
    assert.equal(splits[0].parent, testMind);
    assert.equal(splits[0].dir, "/fake/a");
    assert.equal(splits[0].branch, "branch-a");
  });

  it("addSplit can create multiple splits", () => {
    addMind(testMind, 4200);
    addSplit(`${testMind}-a`, testMind, 4201, "/fake/a", "a");
    addSplit(`${testMind}-b`, testMind, 4202, "/fake/b", "b");
    const splits = findSplits(testMind);
    assert.equal(splits.length, 2);
  });

  it("removeMind removes a split", () => {
    addMind(testMind, 4200);
    addSplit(`${testMind}-a`, testMind, 4201, "/fake/a", "a");
    removeMind(`${testMind}-a`);
    assert.deepStrictEqual(findSplits(testMind), []);
  });

  it("findMind returns split entry", () => {
    addMind(testMind, 4200);
    addSplit(`${testMind}-a`, testMind, 4201, "/fake/a", "a");
    const entry = findMind(`${testMind}-a`);
    assert.ok(entry);
    assert.equal(entry.parent, testMind);
  });

  it("findMind returns undefined for missing split", () => {
    assert.equal(findMind(`${testMind}-nope`), undefined);
  });

  it("cascade delete removes splits when parent is deleted", () => {
    addMind(testMind, 4200);
    addSplit(`${testMind}-a`, testMind, 4201, "/fake/a", "a");
    addSplit(`${testMind}-b`, testMind, 4202, "/fake/b", "b");
    removeMind(testMind);
    assert.equal(findMind(`${testMind}-a`), undefined);
    assert.equal(findMind(`${testMind}-b`), undefined);
  });
});

describe("split running state", () => {
  afterEach(() => {
    try {
      removeMind(testMind);
    } catch {}
  });

  it("setMindRunning works for splits", () => {
    addMind(testMind, 4200);
    addSplit(`${testMind}-a`, testMind, 4201, "/fake/a", "a");
    setMindRunning(`${testMind}-a`, true);
    assert.equal(findMind(`${testMind}-a`)!.running, true);
    setMindRunning(`${testMind}-a`, false);
    assert.equal(findMind(`${testMind}-a`)!.running, false);
  });

  it("readAllMinds includes running splits", () => {
    addMind(testMind, 4200);
    addSplit(`${testMind}-a`, testMind, 4201, "/fake/a", "a");
    setMindRunning(`${testMind}-a`, true);
    const all = readAllMinds();
    const split = all.find((e) => e.name === `${testMind}-a`);
    assert.ok(split);
    assert.equal(split.running, true);
  });
});

describe("getBaseName", () => {
  afterEach(() => {
    try {
      removeMind(testMind);
    } catch {}
  });

  it("returns parent name for a split", () => {
    addMind(testMind, 4200);
    addSplit(`${testMind}-a`, testMind, 4201, "/fake/a", "a");
    assert.equal(getBaseName(`${testMind}-a`), testMind);
  });

  it("returns name itself for base mind", () => {
    addMind(testMind, 4200);
    assert.equal(getBaseName(testMind), testMind);
  });

  it("returns name itself for unknown mind", () => {
    assert.equal(getBaseName("nonexistent"), "nonexistent");
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
