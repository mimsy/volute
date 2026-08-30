import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { stripInheritedVoluteEnv } from "./helpers/test-env.js";
import { sweepStaleTestHomes } from "./helpers/test-home.js";

// Strip GIT_* env vars that are inherited when tests run inside git hooks
// (e.g. pre-push). These vars cause git commands in test temp dirs to target
// the parent repo instead, corrupting its config and causing flaky failures.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}

// Strip inherited VOLUTE_* vars for the same reason. Redirecting VOLUTE_HOME
// below is not enough: modules read other VOLUTE_* vars directly, and an
// inherited one silently points a test at the host's live installation (#805).
stripInheritedVoluteEnv();

// Redirect all volute state to a temp directory so tests never touch
// the live ~/.volute (registry, variants, database, env, etc.)
// On macOS use /tmp rather than os.tmpdir()'s long /var/folders/... path:
// minds get TMPDIR=<mindDir>/.mind/tmp, and tsx creates a unix socket there
// whose path must stay under the 104-byte sun_path limit.
const tmpRoot = process.platform === "darwin" ? "/tmp" : tmpdir();

// Sweep test homes leaked by prior runs that were force-killed before their exit
// cleanup ran. Without this they piled up until they filled the disk (#502). The
// 2h threshold is well past any real run, so a sibling test process running
// concurrently right now keeps its fresh dir.
sweepStaleTestHomes(tmpRoot, 2 * 60 * 60 * 1000);

const testHome = resolve(tmpRoot, `volute-test-${process.pid}`);
// Remove stale test dir from a prior run with the same PID to ensure
// a clean database (avoids migration issues with leftover DB files)
if (existsSync(testHome)) rmSync(testHome, { recursive: true, force: true });
mkdirSync(testHome, { recursive: true });

// Remove this run's test home when the process exits. `node --test --test-force-exit`
// calls process.exit() once tests finish, which still fires synchronous 'exit'
// handlers — so a sync rmSync here reliably cleans up (verified) where an async
// after() hook would be skipped.
process.on("exit", () => {
  try {
    rmSync(testHome, { recursive: true, force: true });
  } catch {
    // Best-effort — the sweep above catches anything left behind next run.
  }
});
mkdirSync(resolve(testHome, "system"), { recursive: true });
process.env.VOLUTE_HOME = testHome;
process.env.VOLUTE_USER_HOME = testHome;

// Initialize database (runs migrations + creates raw connection for registry)
const { getDb } = await import("../packages/daemon/src/lib/db.js");
await getDb();
