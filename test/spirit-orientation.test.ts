import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { resolveTemplate } from "../packages/daemon/src/lib/ai-service.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { addSpirit, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import {
  getSpiritDoctrine,
  getSpiritModel,
  spiritDir,
  syncSpiritTemplate,
  writeSpiritDoctrine,
} from "../packages/daemon/src/lib/mind/spirit.js";
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

    await syncSpiritTemplate(); // second sync: file present — no second notice
    const rows2 = await db
      .select()
      .from(systemEvents)
      .where(and(eq(systemEvents.mind, "volute"), eq(systemEvents.type, "notice")));
    assert.equal(rows2.filter((r) => r.meta?.includes("spirit-md-migration")).length, 1);
  });
});
