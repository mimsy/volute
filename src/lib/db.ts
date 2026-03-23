import { chmodSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { voluteSystemDir } from "./registry.js";
import * as schema from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// In built mode (__dirname = dist/), drizzle is at ../drizzle
// In dev mode (__dirname = src/lib/), drizzle is at ../../drizzle
const migrationsFolder = existsSync(resolve(__dirname, "../drizzle"))
  ? resolve(__dirname, "../drizzle")
  : resolve(__dirname, "../../drizzle");

export type DbInstance = ReturnType<typeof drizzle<typeof schema>>;

let db: DbInstance | null = null;
let dbPromise: Promise<DbInstance> | null = null;

export async function getDb(): Promise<DbInstance> {
  if (db) return db;
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    try {
      const dbPath = process.env.VOLUTE_DB_PATH || resolve(voluteSystemDir(), "volute.db");
      const instance = drizzle({ connection: { url: `file:${dbPath}` }, schema });
      // WAL mode allows concurrent reads during writes; busy_timeout prevents
      // immediate SQLITE_BUSY failures when the DB is briefly locked.
      await instance.run(sql.raw("PRAGMA journal_mode=WAL"));
      await instance.run(sql.raw("PRAGMA busy_timeout=5000"));
      await instance.run(sql.raw("PRAGMA foreign_keys=ON"));
      await migrate(instance, { migrationsFolder });
      // Restrict database file permissions to owner only
      try {
        chmodSync(dbPath, 0o600);
      } catch (err) {
        console.error(
          `[volute] WARNING: Failed to restrict database file permissions on ${dbPath}:`,
          err,
        );
      }
      db = instance;
      return instance;
    } catch (err) {
      dbPromise = null; // Allow retry on next call
      throw err;
    }
  })();
  return dbPromise;
}
