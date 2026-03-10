import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { sql } from "drizzle-orm";
import { getDb } from "../src/lib/db.js";
import { migrateRegistryToDb } from "../src/lib/migrate-registry-to-db.js";
import { voluteSystemDir } from "../src/lib/registry.js";

const suffix = `migrate-reg-${Date.now()}`;

function systemDir() {
  return voluteSystemDir();
}

function mindsJsonPath() {
  return resolve(systemDir(), "minds.json");
}

function variantsJsonPath() {
  return resolve(systemDir(), "variants.json");
}

function cleanFiles() {
  for (const f of [
    mindsJsonPath(),
    `${mindsJsonPath()}.bak`,
    variantsJsonPath(),
    `${variantsJsonPath()}.bak`,
  ]) {
    if (existsSync(f)) rmSync(f);
  }
}

async function cleanDb(names: string[]) {
  const db = await getDb();
  for (const name of names) {
    await db.run(sql`DELETE FROM minds WHERE name = ${name} OR name LIKE ${`${name}@%`}`);
  }
}

describe("migrateRegistryToDb", () => {
  const mindName = `test-mind-${suffix}`;
  const variantName = `test-variant-${suffix}`;
  const orphanParent = `orphan-parent-${suffix}`;

  beforeEach(async () => {
    mkdirSync(systemDir(), { recursive: true });
    cleanFiles();
    await cleanDb([mindName, variantName, orphanParent]);
  });

  afterEach(async () => {
    cleanFiles();
    await cleanDb([mindName, variantName, orphanParent]);
  });

  it("happy path: migrates minds.json and variants.json into DB and creates .bak files", async () => {
    const mindEntries = [
      {
        name: mindName,
        port: 4200,
        stage: "sprouted",
        template: "claude",
        templateHash: "abc123",
        running: false,
        created: "2025-01-01T00:00:00.000Z",
      },
    ];
    const variantEntries = {
      [mindName]: [
        {
          name: variantName,
          branch: "variant-branch",
          path: "/fake/variant/path",
          port: 4201,
          running: false,
          created: "2025-01-02T00:00:00.000Z",
        },
      ],
    };

    writeFileSync(mindsJsonPath(), JSON.stringify(mindEntries));
    writeFileSync(variantsJsonPath(), JSON.stringify(variantEntries));

    await migrateRegistryToDb();

    const db = await getDb();
    const minds = await db.all(sql`SELECT * FROM minds WHERE name = ${mindName}`);
    const mind = minds[0] as any;
    assert.ok(mind, "base mind should be in DB");
    assert.equal(mind.port, 4200);
    assert.equal(mind.stage, "sprouted");
    assert.equal(mind.template, "claude");
    assert.equal(mind.template_hash, "abc123");
    assert.equal(mind.running, 0);

    const variants = await db.all(
      sql`SELECT * FROM minds WHERE name = ${`${mindName}@${variantName}`}`,
    );
    const variant = variants[0] as any;
    assert.ok(variant, "variant should be in DB");
    assert.equal(variant.port, 4201);
    assert.equal(variant.parent, mindName);
    assert.equal(variant.dir, "/fake/variant/path");
    assert.equal(variant.branch, "variant-branch");

    assert.ok(existsSync(`${mindsJsonPath()}.bak`), "minds.json.bak should exist");
    assert.ok(!existsSync(mindsJsonPath()), "minds.json should be renamed");
    assert.ok(existsSync(`${variantsJsonPath()}.bak`), "variants.json.bak should exist");
    assert.ok(!existsSync(variantsJsonPath()), "variants.json should be renamed");
  });

  it("idempotency: running twice does not throw and does not duplicate entries", async () => {
    const mindEntries = [{ name: mindName, port: 4200, created: "2025-01-01T00:00:00.000Z" }];
    writeFileSync(mindsJsonPath(), JSON.stringify(mindEntries));

    await migrateRegistryToDb();
    // After first run, minds.json is renamed to .bak; second run should be a no-op
    await migrateRegistryToDb();

    const db = await getDb();
    const rows = await db.all(sql`SELECT * FROM minds WHERE name = ${mindName}`);
    assert.equal(rows.length, 1, "should have exactly one entry, not duplicated");
  });

  it("corrupt minds.json: does not rename to .bak, logs error", async () => {
    writeFileSync(mindsJsonPath(), "{ not valid json {{");

    await migrateRegistryToDb();

    // minds.json should still be present (not renamed)
    assert.ok(existsSync(mindsJsonPath()), "minds.json should remain when parse fails");
    assert.ok(!existsSync(`${mindsJsonPath()}.bak`), "minds.json.bak should not be created");
  });

  it("corrupt variants.json: does not rename to .bak, logs error", async () => {
    writeFileSync(variantsJsonPath(), ">>> invalid <<<");

    await migrateRegistryToDb();

    assert.ok(existsSync(variantsJsonPath()), "variants.json should remain when parse fails");
    assert.ok(!existsSync(`${variantsJsonPath()}.bak`), "variants.json.bak should not be created");
  });

  it("orphaned variant: variant with non-existent parent fails FK constraint, variants.json not renamed", async () => {
    // No entry for orphanParent in minds.json — only in variants.json.
    // The minds table has a FK on parent → minds.name, so inserting a variant
    // whose parent doesn't exist will fail. The migration logs a warning and
    // does NOT rename variants.json to .bak.
    const variantEntries = {
      [orphanParent]: [
        {
          name: variantName,
          branch: "orphan-branch",
          path: "/fake/orphan/path",
          port: 4300,
          running: false,
          created: "2025-01-03T00:00:00.000Z",
        },
      ],
    };
    writeFileSync(variantsJsonPath(), JSON.stringify(variantEntries));

    await migrateRegistryToDb();

    const db = await getDb();
    const rows = await db.all(
      sql`SELECT * FROM minds WHERE name = ${`${orphanParent}@${variantName}`}`,
    );
    assert.equal(rows.length, 0, "orphaned variant should not be inserted due to FK constraint");

    // variants.json should NOT be renamed to .bak since the insert failed
    assert.ok(existsSync(variantsJsonPath()), "variants.json should remain when insert fails");
    assert.ok(!existsSync(`${variantsJsonPath()}.bak`), "variants.json.bak should not be created");
  });

  it("missing files: returns early when neither minds.json nor variants.json exist", async () => {
    // Ensure neither file exists
    assert.ok(!existsSync(mindsJsonPath()));
    assert.ok(!existsSync(variantsJsonPath()));

    // Should not throw
    await migrateRegistryToDb();

    // DB should have no entries for our test names
    const db = await getDb();
    const rows = await db.all(sql`SELECT * FROM minds WHERE name = ${mindName}`);
    assert.equal(rows.length, 0);
  });
});
