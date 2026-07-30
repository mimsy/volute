import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { isMind, isSystemSpirit } from "@volute/api/user-type";
import { sql } from "drizzle-orm";
import { getDb } from "../packages/daemon/src/lib/db.js";

// Done-bar for #819 Wave B: the shipped data migration must rewrite a live
// spirit row's user_type "system" -> "spirit", leave everyone else (and the
// separate `role` axis) untouched, and the rewritten row must then classify as
// isSystemSpirit and NOT isMind. Reads the actual migration SQL so emptying or
// weakening it fails here — and reverting the predicate flip fails here too.
const migrationSql = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle/0001_migrate_spirit_user_type.sql"),
  "utf-8",
);

describe("0001 migrate spirit user_type", () => {
  it("rewrites the spirit's user_type system -> spirit, leaving role and other rows alone", async () => {
    const db = await getDb();

    // Seed a bardo-shaped pre-migration state: exactly one spirit row still on
    // the old value, plus a mind that must be left untouched. Raw SQL because the
    // typed schema no longer admits "system" as a user_type.
    await db.run(
      sql`INSERT INTO users (username, password_hash, role, user_type, display_name)
          VALUES ('legacy-spirit', '!system', 'system', 'system', 'legacy-spirit')`,
    );
    await db.run(
      sql`INSERT INTO users (username, password_hash, role, user_type)
          VALUES ('legacy-mind', '!mind', 'user', 'mind')`,
    );

    await db.run(sql.raw(migrationSql));

    const spirit = (await db.get(
      sql`SELECT user_type, role FROM users WHERE username = 'legacy-spirit'`,
    )) as { user_type: string; role: string };
    const mind = (await db.get(
      sql`SELECT user_type, role FROM users WHERE username = 'legacy-mind'`,
    )) as { user_type: string; role: string };

    // The value flipped...
    assert.equal(spirit.user_type, "spirit");
    // ...but role (a separate axis, renamed in a later wave) did not...
    assert.equal(spirit.role, "system");
    // ...and non-spirit rows are untouched.
    assert.equal(mind.user_type, "mind");

    // The migrated row now classifies as the keeper, and NOT as a plain mind.
    assert.equal(isSystemSpirit(spirit), true);
    assert.equal(isMind(spirit), false);

    await db.run(sql`DELETE FROM users WHERE username IN ('legacy-spirit', 'legacy-mind')`);
  });

  it("is a forward no-op once no rows hold the old value", async () => {
    const db = await getDb();
    // Re-running against a DB with no "system" rows must not throw or corrupt.
    await db.run(sql.raw(migrationSql));
    const stragglers = (await db.get(
      sql`SELECT count(*) as n FROM users WHERE user_type = 'system'`,
    )) as { n: number };
    assert.equal(stragglers.n, 0);
  });
});
