import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Strip GIT_* env vars that are inherited when tests run inside git hooks
// (e.g. pre-push). These vars cause git commands in test temp dirs to target
// the parent repo instead, corrupting its config and causing flaky failures.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}

// Redirect all volute state to a temp directory so tests never touch
// the live ~/.volute (registry, variants, database, env, etc.)
// On macOS use /tmp rather than os.tmpdir()'s long /var/folders/... path:
// minds get TMPDIR=<mindDir>/.mind/tmp, and tsx creates a unix socket there
// whose path must stay under the 104-byte sun_path limit.
const tmpRoot = process.platform === "darwin" ? "/tmp" : tmpdir();
const testHome = resolve(tmpRoot, `volute-test-${process.pid}`);
// Remove stale test dir from a prior run with the same PID to ensure
// a clean database (avoids migration issues with leftover DB files)
if (existsSync(testHome)) rmSync(testHome, { recursive: true, force: true });
mkdirSync(testHome, { recursive: true });
mkdirSync(resolve(testHome, "system"), { recursive: true });
process.env.VOLUTE_HOME = testHome;
process.env.VOLUTE_USER_HOME = testHome;

// Initialize database (runs migrations + creates raw connection for registry)
const { getDb } = await import("../packages/daemon/src/lib/db.js");
await getDb();
