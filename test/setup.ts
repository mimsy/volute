import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Redirect all volute state to a temp directory so tests never touch
// the live ~/.volute (registry, variants, database, env, etc.)
const testHome = resolve(tmpdir(), `volute-test-${process.pid}`);
mkdirSync(testHome, { recursive: true });
mkdirSync(resolve(testHome, "system"), { recursive: true });
process.env.VOLUTE_HOME = testHome;
process.env.VOLUTE_USER_HOME = testHome;

// Initialize database (runs migrations + creates raw connection for registry)
const { getDb } = await import("../src/lib/db.js");
await getDb();
