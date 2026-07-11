import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { resolveTemplate } from "../packages/daemon/src/lib/ai-service.js";
import { createUser } from "../packages/daemon/src/lib/auth.js";
import { readGlobalConfig, writeGlobalConfig } from "../packages/daemon/src/lib/config/setup.js";
import { addSpirit, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import {
  getSpiritModel,
  notifySpiritSystemChange,
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
import { createSession } from "../packages/daemon/src/web/middleware/auth.js";

const HOOK_PATH = resolve(process.cwd(), "templates/_base/.init/.local/hooks/startup-context.ts");

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

  it("omits the description key from system.json when unset", () => {
    // The hook's "— <description>" only appears when the key is present, so an
    // unset description must not serialize as a key at all (no dangling em dash).
    const dir = spiritDir();
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });

    const config = readGlobalConfig();
    writeGlobalConfig({ ...config, name: "Testarium", description: undefined });
    writeSpiritSystemJson(dir);

    const data = JSON.parse(readFileSync(systemJsonPath(dir), "utf-8"));
    assert.deepEqual(data, { name: "Testarium" });
    assert.equal("description" in data, false);
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

/** Register a spirit row + home/.config dir without the full template project. */
async function registerSpirit(): Promise<string> {
  const dir = spiritDir();
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(resolve(dir, "home/.config"), { recursive: true });
  await addSpirit("volute", 4999, "claude", dir);
  return dir;
}

describe("notifySpiritSystemChange", () => {
  afterEach(async () => {
    await removeMind("volute");
    rmSync(spiritDir(), { recursive: true, force: true });
  });

  it("refreshes system.json even when the spirit isn't reachable to message", async () => {
    // The spirit is registered but not running, so sendSystemMessage can't be
    // delivered — its failure is swallowed by design. system.json must still be
    // refreshed regardless (the note is best-effort; the synced fact is not).
    const dir = await registerSpirit();
    const config = readGlobalConfig();
    writeGlobalConfig({ ...config, name: "Renamed", description: "after rename" });

    await notifySpiritSystemChange();

    const data = JSON.parse(readFileSync(systemJsonPath(dir), "utf-8"));
    assert.deepEqual(data, { name: "Renamed", description: "after rename" });
  });

  it("no-ops when no spirit is registered", async () => {
    await removeMind("volute");
    const dir = spiritDir();
    rmSync(dir, { recursive: true, force: true });

    await notifySpiritSystemChange();

    assert.equal(existsSync(systemJsonPath(dir)), false);
  });

  it("no-ops when the spirit dir is missing", async () => {
    const dir = spiritDir();
    rmSync(dir, { recursive: true, force: true });
    await addSpirit("volute", 4999, "claude", dir);

    await notifySpiritSystemChange();

    assert.equal(existsSync(dir), false);
  });
});

describe("startup-context hook reads system.json", () => {
  function runHook(dir: string): string {
    // cwd stays at the repo root so `--import tsx` resolves; the hook locates
    // system.json via the absolute VOLUTE_MIND_DIR, not cwd. Strip the daemon
    // env so the hook's extension-fetch path stays skipped and the output is
    // hermetic (just the identity line + session line).
    const env = { ...process.env, VOLUTE_MIND_DIR: dir };
    delete env.VOLUTE_DAEMON_PORT;
    delete env.VOLUTE_MIND_TOKEN;
    const out = execFileSync("node", ["--import", "tsx", HOOK_PATH], {
      input: JSON.stringify({ source: "startup" }),
      encoding: "utf-8",
      env,
    });
    return JSON.parse(out).hookSpecificOutput.additionalContext as string;
  }

  it("surfaces the spirit identity written by writeSpiritSystemJson (contract)", () => {
    const dir = spiritDir();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    const config = readGlobalConfig();
    writeGlobalConfig({ ...config, name: "Testarium", description: "a place for tests" });
    writeSpiritSystemJson(dir);

    const context = runHook(dir);

    assert.match(context, /You are the spirit of Testarium — a place for tests\./);
    rmSync(dir, { recursive: true, force: true });
  });

  it("omits the em dash when description is unset", () => {
    const dir = spiritDir();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    const config = readGlobalConfig();
    writeGlobalConfig({ ...config, name: "Testarium", description: undefined });
    writeSpiritSystemJson(dir);

    const context = runHook(dir);

    assert.match(context, /You are the spirit of Testarium\. /);
    assert.doesNotMatch(context, /—/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("stays silent for a mind with no system.json", () => {
    const dir = spiritDir();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(resolve(dir, "home"), { recursive: true });

    const context = runHook(dir);

    assert.doesNotMatch(context, /You are the spirit of/);
    assert.match(context, /Session startup/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("swallows a malformed system.json and stays silent", () => {
    const dir = spiritDir();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    writeFileSync(systemJsonPath(dir), "{ not valid json");

    const context = runHook(dir);

    assert.doesNotMatch(context, /You are the spirit of/);
    assert.match(context, /Session startup/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("PUT /api/system/info notifies the spirit only on a real change", () => {
  afterEach(async () => {
    await removeMind("volute");
    rmSync(spiritDir(), { recursive: true, force: true });
  });

  async function putName(cookie: string, name: string): Promise<number> {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request("/api/system/info", {
      method: "PUT",
      headers: {
        Cookie: `volute_session=${cookie}`,
        Origin: "http://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name }),
    });
    return res.status;
  }

  it("writes system.json only when the trimmed name actually changes", async () => {
    const admin = await createUser("system-info-admin", "pass");
    const cookie = await createSession(admin.id);
    const dir = await registerSpirit();
    const config = readGlobalConfig();
    writeGlobalConfig({ ...config, name: "Alpha", description: undefined });

    // Changed name → notified (system.json recreated with the new name).
    rmSync(systemJsonPath(dir), { force: true });
    assert.equal(await putName(cookie, "Beta"), 200);
    assert.equal(JSON.parse(readFileSync(systemJsonPath(dir), "utf-8")).name, "Beta");

    // Same name → not notified.
    rmSync(systemJsonPath(dir), { force: true });
    assert.equal(await putName(cookie, "Beta"), 200);
    assert.equal(existsSync(systemJsonPath(dir)), false);

    // Same name with surrounding whitespace → trims equal → not notified.
    rmSync(systemJsonPath(dir), { force: true });
    assert.equal(await putName(cookie, "  Beta  "), 200);
    assert.equal(existsSync(systemJsonPath(dir)), false);

    // Cleared name → changes (to undefined) → notified.
    rmSync(systemJsonPath(dir), { force: true });
    assert.equal(await putName(cookie, ""), 200);
    assert.equal(existsSync(systemJsonPath(dir)), true);
  });
});
