import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { Hono } from "hono";
import {
  _clearLoadedExtensionsForTest,
  _registerExtensionForTest,
  getExtensionSpiritSkills,
  getExtensionStandardSkills,
} from "../packages/daemon/src/lib/extensions.js";
import { allSpiritSkills } from "../packages/daemon/src/lib/mind/spirit.js";
import type { ExtensionManifest } from "../packages/extensions/sdk/src/index.js";
import { createExtension } from "../packages/extensions/sdk/src/index.js";

function fakeManifestWithSkills(): ExtensionManifest {
  const skillsDir = mkdtempSync(join(tmpdir(), "ext-spirit-skills-"));
  mkdirSync(join(skillsDir, "garden"));
  mkdirSync(join(skillsDir, "common"));
  return createExtension({
    id: "fake",
    name: "Fake",
    version: "1.0.0",
    routes: () => new Hono(),
    skillsDir,
    standardSkill: true,
    spiritSkills: ["garden"],
  });
}

describe("extension spiritSkills manifest field", () => {
  afterEach(() => {
    _clearLoadedExtensionsForTest();
  });

  it("getExtensionSpiritSkills returns declared spirit skill names", () => {
    _registerExtensionForTest(fakeManifestWithSkills());
    assert.deepEqual(getExtensionSpiritSkills(), ["garden"]);
  });

  it("getExtensionStandardSkills excludes spirit skills even under standardSkill", () => {
    _registerExtensionForTest(fakeManifestWithSkills());
    const standard = getExtensionStandardSkills();
    assert.ok(standard.includes("common"));
    assert.ok(!standard.includes("garden"));
  });

  it("allSpiritSkills combines builtin skills with extension-declared spirit skills", async () => {
    _registerExtensionForTest(fakeManifestWithSkills());
    const all = await allSpiritSkills();
    assert.ok(all.includes("garden"));
    assert.ok(all.includes("tending"));
    assert.ok(!all.includes("plan-coordinator"));
  });
});
