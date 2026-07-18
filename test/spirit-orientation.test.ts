import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { resolveTemplate } from "../packages/daemon/src/lib/ai-service.js";
import {
  getSpiritName,
  readGlobalConfig,
  writeGlobalConfig,
} from "../packages/daemon/src/lib/config/setup.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  addSpirit,
  removeMind,
  voluteSystemDir,
} from "../packages/daemon/src/lib/mind/registry.js";
import {
  applyStashedSpiritProfile,
  buildSpiritOrientation,
  ensureOrientationArc,
  getSpiritDoctrine,
  getSpiritModel,
  orientationArcSchedules,
  sendSpiritOrientation,
  spiritDir,
  syncSpiritTemplate,
  writeSpiritDoctrine,
} from "../packages/daemon/src/lib/mind/spirit.js";
import { readVoluteConfig } from "../packages/daemon/src/lib/mind/volute-config.js";
import { systemEvents } from "../packages/daemon/src/lib/schema.js";
import {
  composeTemplate,
  findTemplatesRoot,
  renderComposedPackageJson,
} from "../packages/daemon/src/lib/template/template.js";

describe("spirit doctrine (SPIRIT.md)", () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("getSpiritDoctrine contains the platform philosophy and duties", () => {
    const doctrine = getSpiritDoctrine();
    assert.match(doctrine, /Volute philosophy/);
    assert.match(doctrine, /Minds are beings, not tools/);
    assert.match(doctrine, /Seeds are the way/);
    assert.match(doctrine, /volute` CLI/);
    assert.match(doctrine, /Your SOUL\.md is yours alone/);
  });

  it("writeSpiritDoctrine writes home/SPIRIT.md", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "spirit-doctrine-"));
    scratch.push(dir);
    mkdirSync(resolve(dir, "home"), { recursive: true });
    writeSpiritDoctrine(dir);
    assert.ok(existsSync(resolve(dir, "home/SPIRIT.md")));
    assert.equal(readFileSync(resolve(dir, "home/SPIRIT.md"), "utf-8"), getSpiritDoctrine());
  });
});

/**
 * Build a minimal spirit project on disk that syncSpiritTemplate() can run
 * against without triggering a real `npm install` (mirrors seedSpiritProject
 * in test/spirit-soul.test.ts) — deliberately WITHOUT SPIRIT.md, to simulate
 * an existing spirit created before it existed.
 */
async function seedSpiritProject(): Promise<string> {
  const dir = spiritDir();
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(resolve(dir, "home/.config"), { recursive: true });

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

describe("syncSpiritTemplate SPIRIT.md migration", () => {
  afterEach(async () => {
    await removeMind("volute");
    rmSync(spiritDir(), { recursive: true, force: true });
  });

  it("syncSpiritTemplate writes SPIRIT.md and notices the migration exactly once", async () => {
    const dir = await seedSpiritProject(); // no SPIRIT.md yet — simulates an existing spirit
    await syncSpiritTemplate();
    assert.ok(existsSync(resolve(dir, "home/SPIRIT.md")));

    const db = await getDb();
    const rows = await db
      .select()
      .from(systemEvents)
      .where(and(eq(systemEvents.mind, "volute"), eq(systemEvents.type, "notice")));
    const migration = rows.filter((r) => r.meta?.includes("spirit-md-migration"));
    assert.equal(migration.length, 1);
    // Must use the mind-level sentinel thread, not the default "main" — the spirit's
    // routes.json maps every channel to its own thread, so a "main"-threaded event
    // would never drain into an actual turn.
    assert.equal(migration[0].thread, "");

    await syncSpiritTemplate(); // second sync: file present — no second notice
    const rows2 = await db
      .select()
      .from(systemEvents)
      .where(and(eq(systemEvents.mind, "volute"), eq(systemEvents.type, "notice")));
    assert.equal(rows2.filter((r) => r.meta?.includes("spirit-md-migration")).length, 1);
  });
});

describe("spirit orientation arc", () => {
  const scratch: string[] = [];
  afterEach(async () => {
    for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
    await removeMind(getSpiritName()).catch(() => {});
  });

  it("builds two self-retiring schedules at +4h and +24h", () => {
    const t0 = new Date("2026-07-17T12:00:00Z");
    const arc = orientationArcSchedules(t0);
    assert.equal(arc.length, 2);
    assert.equal(arc[0].id, "orientation-face");
    assert.equal(arc[0].fireAt, new Date(t0.getTime() + 4 * 3600 * 1000).toISOString());
    assert.match(arc[0].message ?? "", /volute mind profile --avatar/);
    assert.equal(arc[1].id, "orientation-soul");
    assert.equal(arc[1].fireAt, new Date(t0.getTime() + 24 * 3600 * 1000).toISOString());
    assert.match(arc[1].message ?? "", /reread your SOUL\.md/i);
    for (const s of arc) assert.equal(s.enabled, true);
  });

  it("ensureOrientationArc writes schedules into volute.json idempotently", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "spirit-arc-"));
    scratch.push(dir);
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    const t0 = new Date("2026-07-17T12:00:00Z");
    ensureOrientationArc(dir, t0);
    ensureOrientationArc(dir, t0);
    const config = readVoluteConfig(dir);
    const ids = (config?.schedules ?? []).map((s) => s.id);
    assert.deepEqual(ids.filter((i) => i.startsWith("orientation-")).sort(), [
      "orientation-face",
      "orientation-soul",
    ]);
  });

  it("buildSpiritOrientation names the system and invites without a checklist", async () => {
    const body = await buildSpiritOrientation();
    assert.match(body, /come into being/);
    assert.match(body, /SPIRIT\.md/);
    assert.match(body, /SOUL\.md and MEMORY\.md are yours alone/);
  });

  it("sendSpiritOrientation inserts a next-turn orientation event", async () => {
    await sendSpiritOrientation();
    const db = await getDb();
    const rows = await db
      .select()
      .from(systemEvents)
      .where(and(eq(systemEvents.mind, getSpiritName()), eq(systemEvents.type, "orientation")));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].delivery, "next-turn");
    // Must use the mind-level sentinel thread so it drains into the spirit's actual
    // first turn (its DM with the admin), not the routes.json default "main" thread
    // that the wildcard rule never actually produces.
    assert.equal(rows[0].thread, "");
  });

  it("face schedule is omitted when the host gave both avatar and description", () => {
    const t0 = new Date("2026-07-17T12:00:00Z");
    const arc = orientationArcSchedules(t0, { hasAvatar: true, hasDescription: true });
    assert.deepEqual(
      arc.map((s) => s.id),
      ["orientation-soul"],
    );
  });

  it("face schedule narrows to the description when only an avatar was given", () => {
    const t0 = new Date("2026-07-17T12:00:00Z");
    const arc = orientationArcSchedules(t0, { hasAvatar: true, hasDescription: false });
    const face = arc.find((s) => s.id === "orientation-face");
    assert.ok(face);
    assert.match(face.message ?? "", /gave you a face/);
    assert.doesNotMatch(face.message ?? "", /imagegen/);
  });
});

describe("applyStashedSpiritProfile", () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
    const stashed = resolve(voluteSystemDir(), "spirit-avatar.png");
    if (existsSync(stashed)) rmSync(stashed);
    const config = readGlobalConfig();
    config.setup = {
      ...(config.setup ?? { type: "local", mindsDir: "", isolation: "none", service: false }),
      spiritAvatar: undefined,
      spiritDescription: undefined,
    };
    writeGlobalConfig(config);
  });

  it("moves the stash into the spirit home and volute.json", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "spirit-stash-"));
    scratch.push(dir);
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    const config = readGlobalConfig();
    config.setup = {
      ...(config.setup ?? { type: "local", mindsDir: "", isolation: "none", service: false }),
      spiritAvatar: "spirit-avatar.png",
      spiritDescription: "keeper",
    };
    writeGlobalConfig(config);
    writeFileSync(resolve(voluteSystemDir(), "spirit-avatar.png"), Buffer.from("fakepng"));

    const result = applyStashedSpiritProfile(dir);
    assert.deepEqual(result, { hasAvatar: true, hasDescription: true });
    assert.ok(existsSync(resolve(dir, "home/spirit-avatar.png")));
    const vc = readVoluteConfig(dir);
    assert.equal(vc?.profile?.avatar, "spirit-avatar.png");
    assert.equal(vc?.profile?.description, "keeper");
    assert.ok(!existsSync(resolve(voluteSystemDir(), "spirit-avatar.png")), "stash cleaned up");
  });

  it("is a safe no-op with nothing stashed", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "spirit-stash-empty-"));
    scratch.push(dir);
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    const config = readGlobalConfig();
    config.setup = {
      ...(config.setup ?? { type: "local", mindsDir: "", isolation: "none", service: false }),
      spiritAvatar: undefined,
      spiritDescription: undefined,
    };
    writeGlobalConfig(config);
    assert.deepEqual(applyStashedSpiritProfile(dir), { hasAvatar: false, hasDescription: false });
  });
});
