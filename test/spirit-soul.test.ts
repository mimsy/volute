import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { resolveTemplate } from "../packages/daemon/src/lib/ai-service.js";
import { readGlobalConfig, writeGlobalConfig } from "../packages/daemon/src/lib/config/setup.js";
import { addSpirit } from "../packages/daemon/src/lib/mind/registry.js";
import {
  getSpiritModel,
  seedSpiritSoulIfMissing,
  spiritDir,
  syncSpiritTemplate,
  writeSpiritSystemJson,
} from "../packages/daemon/src/lib/mind/spirit.js";
import {
  composeTemplate,
  findTemplatesRoot,
  renderComposedPackageJson,
} from "../packages/daemon/src/lib/template/template.js";

const CUSTOM_SOUL = "# My own soul\n\nI have written this myself. Do not overwrite me.\n";

function soulPath(dir: string): string {
  return resolve(dir, "home/SOUL.md");
}

function systemJsonPath(dir: string): string {
  return resolve(dir, "home/.config/system.json");
}

/**
 * Build a minimal spirit project on disk that syncSpiritTemplate() can run
 * against without triggering a real `npm install`: pre-seed a package.json that
 * matches the composed template and a node_modules/ dir so the re-install check
 * is a no-op.
 */
async function seedSpiritProject(): Promise<string> {
  const dir = spiritDir();
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(resolve(dir, "home/.config"), { recursive: true });

  // Seed with whatever template syncSpiritTemplate will resolve for this env, and
  // pre-place a matching package.json + node_modules so the sync's re-install
  // check is a no-op (avoids a real, slow `npm install`).
  const template = await resolveTemplate(getSpiritModel());
  const templatesRoot = findTemplatesRoot();
  const { composedDir } = composeTemplate(templatesRoot, template);
  cpSync(resolve(composedDir, "src"), resolve(dir, "src"), { recursive: true });
  const pkg = renderComposedPackageJson(composedDir, "volute");
  assert.ok(pkg, "expected a rendered package.json");
  cpSync(pkg, resolve(dir, "package.json"));
  mkdirSync(resolve(dir, "node_modules"), { recursive: true });

  await addSpirit("volute", 4999, template, dir);
  return dir;
}

describe("spirit SOUL.md ownership", () => {
  afterEach(() => {
    rmSync(spiritDir(), { recursive: true, force: true });
  });

  it("seeds SOUL.md when missing", () => {
    const dir = spiritDir();
    mkdirSync(resolve(dir, "home"), { recursive: true });
    assert.equal(existsSync(soulPath(dir)), false);

    const wrote = seedSpiritSoulIfMissing(dir);

    assert.equal(wrote, true);
    assert.match(readFileSync(soulPath(dir), "utf-8"), /You are Volute/);
  });

  it("leaves an existing SOUL.md untouched", () => {
    const dir = spiritDir();
    mkdirSync(resolve(dir, "home"), { recursive: true });
    writeFileSync(soulPath(dir), CUSTOM_SOUL);

    const wrote = seedSpiritSoulIfMissing(dir);

    assert.equal(wrote, false);
    assert.equal(readFileSync(soulPath(dir), "utf-8"), CUSTOM_SOUL);
  });

  it("writes system name/description to system.json without touching SOUL", () => {
    const dir = spiritDir();
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    writeFileSync(soulPath(dir), CUSTOM_SOUL);

    const config = readGlobalConfig();
    writeGlobalConfig({ ...config, name: "Testarium", description: "a place for tests" });
    writeSpiritSystemJson(dir);

    const data = JSON.parse(readFileSync(systemJsonPath(dir), "utf-8"));
    assert.deepEqual(data, { name: "Testarium", description: "a place for tests" });
    assert.equal(readFileSync(soulPath(dir), "utf-8"), CUSTOM_SOUL);
  });

  it("preserves an edited SOUL.md across a template sync and refreshes system.json", async () => {
    const dir = await seedSpiritProject();
    writeFileSync(soulPath(dir), CUSTOM_SOUL);

    const config = readGlobalConfig();
    writeGlobalConfig({ ...config, name: "Testarium", description: undefined });

    await syncSpiritTemplate();

    // Self-owned SOUL survives the sync.
    assert.equal(readFileSync(soulPath(dir), "utf-8"), CUSTOM_SOUL);
    // System identity is refreshed into system.json instead.
    const data = JSON.parse(readFileSync(systemJsonPath(dir), "utf-8"));
    assert.equal(data.name, "Testarium");
  });

  it("recreates a deleted SOUL.md on sync (self-healing)", async () => {
    const dir = await seedSpiritProject();
    rmSync(soulPath(dir), { force: true });

    await syncSpiritTemplate();

    assert.equal(existsSync(soulPath(dir)), true);
    assert.match(readFileSync(soulPath(dir), "utf-8"), /You are Volute/);
  });
});
