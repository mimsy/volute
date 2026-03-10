import { chmodSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import type Database from "libsql";
import { voluteSystemDir } from "./registry.js";
import * as schema from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// In built mode (__dirname = dist/), drizzle is at ../drizzle
// In dev mode (__dirname = src/lib/), drizzle is at ../../drizzle
const migrationsFolder = existsSync(resolve(__dirname, "../drizzle"))
  ? resolve(__dirname, "../drizzle")
  : resolve(__dirname, "../../drizzle");

export type DbInstance = ReturnType<typeof drizzle<typeof schema>>;
export type RawDb = InstanceType<typeof Database>;

let db: DbInstance | null = null;
let rawDb: RawDb | null = null;

export async function getDb(): Promise<DbInstance> {
  if (db) return db;
  const dbPath = process.env.VOLUTE_DB_PATH || resolve(voluteSystemDir(), "volute.db");
  db = drizzle({ connection: { url: `file:${dbPath}` }, schema });
  await migrate(db, { migrationsFolder });
  // Restrict database file permissions to owner only
  try {
    chmodSync(dbPath, 0o600);
  } catch (err) {
    console.error(
      `[volute] WARNING: Failed to restrict database file permissions on ${dbPath}:`,
      err,
    );
  }

  // Create raw synchronous connection for registry operations
  const DatabaseConstructor = (await import("libsql")).default;
  rawDb = new DatabaseConstructor(dbPath);
  rawDb.pragma("journal_mode = WAL");
  rawDb.pragma("foreign_keys = ON");
  rawDb.pragma("busy_timeout = 5000");

  return db;
}

/**
 * Synchronous raw sqlite3 connection for registry operations.
 * Throws if DB has not been initialized via getDb().
 */
export function getRawDb(): RawDb {
  if (!rawDb) throw new Error("Database not initialized — call getDb() first");
  return rawDb;
}
