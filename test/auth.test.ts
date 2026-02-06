import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  approveUser,
  createUser,
  getUser,
  getUserByUsername,
  listPendingUsers,
  listUsers,
  verifyUser,
} from "../src/lib/auth.js";
import { getDb } from "../src/lib/db.js";
import { conversations, messages, users } from "../src/lib/schema.js";

async function cleanup() {
  const db = await getDb();
  await db.delete(messages);
  await db.delete(conversations);
  await db.delete(users);
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
});
