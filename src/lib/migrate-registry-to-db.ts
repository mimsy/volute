import { existsSync, readFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { getRawDb } from "./db.js";
import log from "./logger.js";
import { voluteSystemDir } from "./registry.js";

type LegacyMindEntry = {
  name: string;
  port: number;
  created: string;
  running?: boolean;
  stage?: string;
  template?: string;
  templateHash?: string;
};

type LegacyVariant = {
  name: string;
  branch: string;
  path: string;
  port: number;
  created: string;
  running?: boolean;
};

/**
 * Migrate minds.json + variants.json into the `minds` DB table.
 * Idempotent — skips if JSON files don't exist (already migrated or fresh install).
 */
export function migrateRegistryToDb(): void {
  const systemDir = voluteSystemDir();
  const mindsJsonPath = resolve(systemDir, "minds.json");
  const variantsJsonPath = resolve(systemDir, "variants.json");

  if (!existsSync(mindsJsonPath) && !existsSync(variantsJsonPath)) return;

  const db = getRawDb();

  const insertMind = db.prepare(
    `INSERT INTO minds (name, port, stage, template, template_hash, running, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO NOTHING`,
  );

  const insertSplit = db.prepare(
    `INSERT INTO minds (name, port, parent, dir, branch, running, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO NOTHING`,
  );

  // Read minds.json
  let mindEntries: LegacyMindEntry[] = [];
  let mindsParseOk = true;
  if (existsSync(mindsJsonPath)) {
    try {
      mindEntries = JSON.parse(readFileSync(mindsJsonPath, "utf-8"));
    } catch (err) {
      mindsParseOk = false;
      log.error("failed to parse minds.json during migration", { error: err });
    }
  }

  // Read variants.json
  let allVariants: Record<string, LegacyVariant[]> = {};
  let variantsParseOk = true;
  if (existsSync(variantsJsonPath)) {
    try {
      allVariants = JSON.parse(readFileSync(variantsJsonPath, "utf-8"));
    } catch (err) {
      variantsParseOk = false;
      log.error("failed to parse variants.json during migration", { error: err });
    }
  }

  // Insert base minds
  let mindFailCount = 0;
  for (const entry of mindEntries) {
    try {
      insertMind.run(
        entry.name,
        entry.port,
        entry.stage ?? "sprouted",
        entry.template ?? null,
        entry.templateHash ?? null,
        entry.running ? 1 : 0,
        entry.created,
      );
    } catch (err) {
      mindFailCount++;
      log.warn(`failed to migrate mind ${entry.name} to DB`, { error: err });
    }
  }

  // Insert variants as splits
  let variantFailCount = 0;
  for (const [mindName, variants] of Object.entries(allVariants)) {
    for (const v of variants) {
      try {
        insertSplit.run(
          `${mindName}@${v.name}`,
          v.port,
          mindName,
          v.path,
          v.branch,
          v.running ? 1 : 0,
          v.created,
        );
      } catch (err) {
        variantFailCount++;
        log.warn(`failed to migrate variant ${mindName}@${v.name} to DB`, { error: err });
      }
    }
  }

  if (mindFailCount > 0) {
    log.error(`${mindFailCount} mind(s) failed to migrate — minds.json will not be renamed`);
  }
  if (variantFailCount > 0) {
    log.error(
      `${variantFailCount} variant(s) failed to migrate — variants.json will not be renamed`,
    );
  }

  // Only rename to .bak if parse succeeded and all inserts succeeded
  if (mindsParseOk && mindFailCount === 0) {
    try {
      if (existsSync(mindsJsonPath)) {
        renameSync(mindsJsonPath, `${mindsJsonPath}.bak`);
      }
    } catch (err) {
      log.warn("failed to rename minds.json to .bak", { error: err });
    }
  }

  if (variantsParseOk && variantFailCount === 0) {
    try {
      if (existsSync(variantsJsonPath)) {
        renameSync(variantsJsonPath, `${variantsJsonPath}.bak`);
      }
    } catch (err) {
      log.warn("failed to rename variants.json to .bak", { error: err });
    }
  }

  const count = mindEntries.length + Object.values(allVariants).flat().length;
  if (count > 0) {
    log.info(`migrated ${count} entries from JSON to DB`);
  }
}
