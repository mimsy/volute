import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { VOLUTE_HOME } from "./registry.js";
import * as schema from "./schema.js";

export type DbInstance = ReturnType<typeof drizzle<typeof schema>>;

let db: DbInstance | null = null;

export async function getDb(): Promise<DbInstance> {
  if (db) return db;
  const dbPath = resolve(VOLUTE_HOME, "volute.db");
  db = drizzle({ connection: { url: `file:${dbPath}` }, schema });
  try {
    await migrate(db, { migrationsFolder: "./drizzle" });
  } catch (e: unknown) {
    // Tolerate "already exists" from pre-Drizzle databases
    if (!(e instanceof Error) || !e.message.includes("already exists")) throw e;
  }
  return db;
}
