import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import {
  findExternalNameCollisions,
  NAME_COLLISION_ALERT_KIND,
  reportExternalNameCollisions,
} from "../packages/daemon/src/lib/chat/name-collisions.js";
import { getSpiritName } from "../packages/daemon/src/lib/config/setup.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { voluteSystemDir } from "../packages/daemon/src/lib/mind/registry.js";
import { activity, systemEvents, users } from "../packages/daemon/src/lib/schema.js";

type UserType = "human" | "mind" | "puppet" | "spirit";

async function seedUser(username: string, userType: UserType): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .insert(users)
    .values({
      username,
      password_hash: userType === "puppet" ? "!puppet" : "x",
      role: "user",
      user_type: userType,
    })
    .returning({ id: users.id });
  return row.id;
}

async function deleteUser(id: number): Promise<void> {
  const db = await getDb();
  await db.delete(users).where(eq(users.id, id));
}

/**
 * The spirit is the alert target, and the state file makes the alert once-ever —
 * clear both so each test sees only what it caused.
 */
async function clearAlertState(): Promise<void> {
  const db = await getDb();
  await db.delete(systemEvents).where(eq(systemEvents.mind, getSpiritName()));
  await db.delete(activity).where(eq(activity.mind, getSpiritName()));
  rmSync(resolve(voluteSystemDir(), "external-name-collisions.json"), { force: true });
}

async function spiritEvents() {
  const db = await getDb();
  return db.select().from(systemEvents).where(eq(systemEvents.mind, getSpiritName()));
}

async function spiritActivity() {
  const db = await getDb();
  return db.select().from(activity).where(eq(activity.mind, getSpiritName()));
}

describe("external-sender name collisions", () => {
  beforeEach(clearAlertState);

  it("finds a non-puppet account holding a platform:handle name", async () => {
    const id = await seedUser("discord:alice", "human");
    try {
      const found = await findExternalNameCollisions();
      assert.deepEqual(
        found.map((c) => [c.username, c.userType]),
        [["discord:alice", "human"]],
      );
    } finally {
      await deleteUser(id);
    }
  });

  it("alerts the host, naming the account and the command to run", async () => {
    const id = await seedUser("discord:alice", "human");
    try {
      await reportExternalNameCollisions();

      const events = await spiritEvents();
      assert.equal(events.length, 1, "expected exactly one alert event");
      const [event] = events;
      assert.equal(event.type, "notice");
      assert.equal(JSON.parse(event.meta ?? "{}").subtype, NAME_COLLISION_ALERT_KIND);
      assert.match(event.body, /discord:alice/);
      // The remedy has to be a command a host can actually run: there is no
      // `volute` rename, so the message must hand over the DB edit instead.
      assert.match(event.body, /no `volute` command that renames an account/);
      assert.match(event.body, /sqlite3 .*volute\.db/);
      assert.match(
        event.body,
        new RegExp(`UPDATE users SET username = 'newname' WHERE id = ${id};`),
      );

      const rows = await spiritActivity();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].type, "mind_error");
      assert.match(rows[0].summary ?? "", /discord:alice/);
    } finally {
      await deleteUser(id);
    }
  });

  it("never puts the colliding name where it would be executed", async () => {
    const hostile = 'discord:a"; rm -rf /tmp/nothing; echo "';
    const id = await seedUser(hostile, "human");
    try {
      await reportExternalNameCollisions();
      const [event] = await spiritEvents();
      assert.ok(event, "expected an alert");
      // The name appears only JSON-quoted in prose; the sqlite3 line matches on the id.
      assert.match(event.body, new RegExp(`WHERE id = ${id};"`));
      assert.ok(
        !event.body.includes(`'${hostile}'`) && !event.body.includes(`"${hostile}"`),
        "the raw name must never be pasted into the command",
      );
      assert.ok(event.body.includes(JSON.stringify(hostile)));
    } finally {
      await deleteUser(id);
    }
  });

  it("alerts once per account, not on every daemon start", async () => {
    const id = await seedUser("discord:alice", "human");
    try {
      await reportExternalNameCollisions();
      await reportExternalNameCollisions();
      assert.equal((await spiritEvents()).length, 1);
    } finally {
      await deleteUser(id);
    }
  });

  it("says nothing about puppets, which own the platform:handle namespace", async () => {
    const id = await seedUser("discord:bob", "puppet");
    try {
      assert.deepEqual(await findExternalNameCollisions(), []);
      await reportExternalNameCollisions();
      assert.deepEqual(await spiritEvents(), []);
      assert.deepEqual(await spiritActivity(), []);
    } finally {
      await deleteUser(id);
    }
  });

  it("leaves the colliding row untouched", async () => {
    const id = await seedUser("slack:carol", "human");
    try {
      await reportExternalNameCollisions();
      const db = await getDb();
      const row = await db.select().from(users).where(eq(users.id, id)).get();
      assert.equal(row?.username, "slack:carol");
      assert.equal(row?.user_type, "human");
    } finally {
      await deleteUser(id);
    }
  });
});
