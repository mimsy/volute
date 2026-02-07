import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Redirect all volute state to a temp directory so tests never touch
// the live ~/.volute (registry, variants, database, env, etc.)
const testHome = resolve(tmpdir(), `volute-test-${process.pid}`);
mkdirSync(testHome, { recursive: true });
process.env.VOLUTE_HOME = testHome;
