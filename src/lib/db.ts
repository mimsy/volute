import { chmodSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { voluteHome } from "./registry.js";
import * as schema from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// In built mode (__dirname = dist/), drizzle is at ../drizzle
// In dev mode (__dirname = src/lib/), drizzle is at ../../drizzle
const migrationsFolder = existsSync(resolve(__dirname, "../drizzle"))
  ? resolve(__dirname, "../drizzle")
  : resolve(__dirname, "../../drizzle");

export type DbInstance = ReturnType<typeof drizzle<typeof schema>>;

let db: DbInstance | null = null;

export async function getDb(): Promise<DbInstance> {
  if (db) return db;
  const dbPath = process.env.VOLUTE_DB_PATH || resolve(voluteHome(), "volute.db");
  db = drizzle({ connection: { url: `file:${dbPath}` }, schema });
  try {
    await migrate(db, { migrationsFolder });
  } catch (e: unknown) {
    // Tolerate "already exists" from pre-Drizzle databases
    if (!(e instanceof Error) || !e.message.includes("already exists")) throw e;
  }
  // Restrict database file permissions to owner only
  try {
    chmodSync(dbPath, 0o600);
  } catch {}
  return db;
}
