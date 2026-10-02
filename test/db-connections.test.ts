import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { sql } from "drizzle-orm";
import { getDb } from "../packages/daemon/src/lib/db.js";

// @libsql/client keeps a pool of connections, and every call that overlaps another one
// (any two un-awaited queries) is served by a different connection. A per-connection
// PRAGMA run once in getDb() reaches only the first of them; the rest used to open with
// busy_timeout=0 and fail SQLITE_BUSY the instant anything else held the write lock (#1344).
describe("db connections", () => {
  it("every pooled connection waits on a busy database", async () => {
    const db = await getDb();
    const rows = await Promise.all(
      Array.from({ length: 6 }, () => db.all<{ timeout: number }>(sql`PRAGMA busy_timeout`)),
    );
    assert.deepEqual(
      rows.map((r) => r[0].timeout),
      Array(6).fill(5000),
    );
  });

  it("every pooled connection enforces foreign keys", async () => {
    const db = await getDb();
    const rows = await Promise.all(
      Array.from({ length: 6 }, () => db.all<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`)),
    );
    assert.deepEqual(
      rows.map((r) => r[0].foreign_keys),
      Array(6).fill(1),
    );
  });

  // An async `db.transaction` holds BEGIN IMMEDIATE on its own connection across awaits.
  // Any write on another connection meanwhile busy-waits *synchronously*, blocking the
  // event loop the transaction needs to commit — so both sit out the whole busy timeout
  // and the write fails. Use `db.batch()`, which runs BEGIN…COMMIT in one synchronous call.
  it("daemon code never holds a transaction open across awaits", () => {
    const root = resolve(import.meta.dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "dist") continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.ts$/.test(name) && /\b(db|tx)\.transaction\(/.test(readFileSync(path, "utf-8")))
          offenders.push(relative(root, path));
      }
    };
    // Everything that can open volute.db: the daemon, extensions (handed the daemon's db,
    // or opening their own), the CLI, and the root daemon-lifecycle commands.
    for (const dir of ["packages/daemon/src", "packages/extensions", "packages/cli/src", "src"])
      walk(join(root, dir));
    assert.deepEqual(offenders, []);
  });
});
