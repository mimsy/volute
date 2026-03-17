import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import {
  approveUser,
  createUser,
  deleteMindUser,
  getOrCreateMindUser,
  getUser,
  getUserByUsername,
  listPendingUsers,
  listUsers,
  listUsersByType,
  verifyUser,
} from "../src/lib/auth.js";
import { getDb } from "../src/lib/db.js";
import { users } from "../src/lib/schema.js";

const TEST_USERNAMES = [
  "admin1",
  "user2",
  "testuser",
  "lookup",
  "findme",
  "u1",
  "u2",
  "admin",
  "pending1",
  "pending2",
  "newuser",
  "my-mind",
  "mind-login",
  "delete-me",
  "keep-me",
  "human1",
  "mind1",
];

async function cleanup() {
  const db = await getDb();
  for (const username of TEST_USERNAMES) {
    await db.delete(users).where(eq(users.username, username));
  }
}

describe("auth", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("createUser first user becomes admin", async () => {
    const user = await createUser("admin1", "pass123");
    assert.equal(user.role, "admin");
    assert.equal(user.username, "admin1");
  });

  it("createUser subsequent users are pending", async () => {
    await createUser("admin1", "pass123");
    const user2 = await createUser("user2", "pass456");
    assert.equal(user2.role, "pending");
  });

  it("verifyUser correct password returns user", async () => {
    await createUser("testuser", "secret");
    const user = await verifyUser("testuser", "secret");
    assert.ok(user);
    assert.equal(user.username, "testuser");
  });

  it("verifyUser wrong password returns null", async () => {
    await createUser("testuser", "secret");
    const user = await verifyUser("testuser", "wrong");
    assert.equal(user, null);
  });

  it("verifyUser nonexistent user returns null", async () => {
    const user = await verifyUser("ghost", "pass");
    assert.equal(user, null);
  });

  it("getUser returns user by id", async () => {
    const created = await createUser("lookup", "pass");
    const found = await getUser(created.id);
    assert.ok(found);
    assert.equal(found.username, "lookup");
  });

  it("getUserByUsername returns user", async () => {
    await createUser("findme", "pass");
    const found = await getUserByUsername("findme");
    assert.ok(found);
    assert.equal(found.username, "findme");
  });

  it("listUsers returns all users", async () => {
    await createUser("u1", "p1");
    await createUser("u2", "p2");
    const all = await listUsers();
    assert.equal(all.length, 2);
  });

  it("listPendingUsers returns only pending", async () => {
    await createUser("admin", "p1"); // admin
    await createUser("pending1", "p2"); // pending
    await createUser("pending2", "p3"); // pending
    const pending = await listPendingUsers();
    assert.equal(pending.length, 2);
    assert.ok(pending.every((u) => u.role === "pending"));
  });

  it("approveUser changes role from pending to user", async () => {
    await createUser("admin", "p1");
    const pending = await createUser("newuser", "p2");
    assert.equal(pending.role, "pending");
    await approveUser(pending.id);
    const approved = await getUser(pending.id);
    assert.ok(approved);
    assert.equal(approved.role, "user");
  });

  it("getOrCreateMindUser creates mind user", async () => {
    const mind = await getOrCreateMindUser("my-mind");
    assert.equal(mind.username, "my-mind");
    assert.equal(mind.user_type, "mind");
    assert.equal(mind.role, "user");

    // Calling again returns the same user
    const again = await getOrCreateMindUser("my-mind");
    assert.equal(again.id, mind.id);
  });

  it("verifyUser rejects mind users", async () => {
    await getOrCreateMindUser("mind-login");
    const result = await verifyUser("mind-login", "anything");
    assert.equal(result, null);
  });

  it("deleteMindUser removes mind user", async () => {
    const mind = await getOrCreateMindUser("delete-me");
    assert.ok(mind.id);
    await deleteMindUser("delete-me");
    const found = await getUserByUsername("delete-me");
    assert.equal(found, null);
  });

  it("deleteMindUser does not affect human users", async () => {
    const human = await createUser("keep-me", "pass");
    await deleteMindUser("keep-me");
    const found = await getUser(human.id);
    assert.ok(found);
    assert.equal(found.username, "keep-me");
  });

  it("listUsersByType filters by type", async () => {
    await createUser("human1", "p1");
    await getOrCreateMindUser("mind1");

    const humans = await listUsersByType("brain");
    assert.ok(humans.every((u) => u.user_type === "brain"));
    assert.ok(humans.some((u) => u.username === "human1"));

    const minds = await listUsersByType("mind");
    assert.ok(minds.every((u) => u.user_type === "mind"));
    assert.ok(minds.some((u) => u.username === "mind1"));
  });
});
