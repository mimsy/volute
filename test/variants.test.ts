import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  addMind,
  addVariant,
  findMind,
  findVariants,
  getBaseName,
  readAllMinds,
  removeMind,
  setMindRunning,
} from "../packages/daemon/src/lib/registry.js";
import { validateBranchName } from "../packages/daemon/src/lib/variants.js";

const testMind = `test-mind-${Date.now()}`;

describe("variants CRUD", () => {
  afterEach(async () => {
    try {
      await removeMind(testMind);
    } catch {}
  });

  it("findVariants returns empty array when no variants", async () => {
    await addMind(testMind, 4200);
    assert.deepStrictEqual(await findVariants(testMind), []);
  });

  it("addVariant creates a variant linked to parent", async () => {
    await addMind(testMind, 4200);
    await addVariant(`${testMind}-a`, testMind, 4201, "/fake/a", "branch-a");
    const splits = await findVariants(testMind);
    assert.equal(splits.length, 1);
    assert.equal(splits[0].name, `${testMind}-a`);
    assert.equal(splits[0].parent, testMind);
    assert.equal(splits[0].dir, "/fake/a");
    assert.equal(splits[0].branch, "branch-a");
  });

  it("addVariant can create multiple variants", async () => {
    await addMind(testMind, 4200);
    await addVariant(`${testMind}-a`, testMind, 4201, "/fake/a", "a");
    await addVariant(`${testMind}-b`, testMind, 4202, "/fake/b", "b");
    const splits = await findVariants(testMind);
    assert.equal(splits.length, 2);
  });

  it("removeMind removes a variant", async () => {
    await addMind(testMind, 4200);
    await addVariant(`${testMind}-a`, testMind, 4201, "/fake/a", "a");
    await removeMind(`${testMind}-a`);
    assert.deepStrictEqual(await findVariants(testMind), []);
  });

  it("findMind returns variant entry", async () => {
    await addMind(testMind, 4200);
    await addVariant(`${testMind}-a`, testMind, 4201, "/fake/a", "a");
    const entry = await findMind(`${testMind}-a`);
    assert.ok(entry);
    assert.equal(entry.parent, testMind);
  });

  it("findMind returns undefined for missing variant", async () => {
    assert.equal(await findMind(`${testMind}-nope`), undefined);
  });

  it("cascade delete removes variants when parent is deleted", async () => {
    await addMind(testMind, 4200);
    await addVariant(`${testMind}-a`, testMind, 4201, "/fake/a", "a");
    await addVariant(`${testMind}-b`, testMind, 4202, "/fake/b", "b");
    await removeMind(testMind);
    assert.equal(await findMind(`${testMind}-a`), undefined);
    assert.equal(await findMind(`${testMind}-b`), undefined);
  });
});

describe("variant running state", () => {
  afterEach(async () => {
    try {
      await removeMind(testMind);
    } catch {}
  });

  it("setMindRunning works for variants", async () => {
    await addMind(testMind, 4200);
    await addVariant(`${testMind}-a`, testMind, 4201, "/fake/a", "a");
    await setMindRunning(`${testMind}-a`, true);
    assert.equal((await findMind(`${testMind}-a`))!.running, true);
    await setMindRunning(`${testMind}-a`, false);
    assert.equal((await findMind(`${testMind}-a`))!.running, false);
  });

  it("readAllMinds includes running variants", async () => {
    await addMind(testMind, 4200);
    await addVariant(`${testMind}-a`, testMind, 4201, "/fake/a", "a");
    await setMindRunning(`${testMind}-a`, true);
    const all = await readAllMinds();
    const split = all.find((e) => e.name === `${testMind}-a`);
    assert.ok(split);
    assert.equal(split.running, true);
  });
});

describe("getBaseName", () => {
  afterEach(async () => {
    try {
      await removeMind(testMind);
    } catch {}
  });

  it("returns parent name for a variant", async () => {
    await addMind(testMind, 4200);
    await addVariant(`${testMind}-a`, testMind, 4201, "/fake/a", "a");
    assert.equal(await getBaseName(`${testMind}-a`), testMind);
  });

  it("returns name itself for base mind", async () => {
    await addMind(testMind, 4200);
    assert.equal(await getBaseName(testMind), testMind);
  });

  it("returns name itself for unknown mind", async () => {
    assert.equal(await getBaseName("nonexistent"), "nonexistent");
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
