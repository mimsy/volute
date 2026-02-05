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

function cleanup() {
  const db = getDb();
  db.prepare("DELETE FROM messages").run();
  db.prepare("DELETE FROM conversations").run();
  db.prepare("DELETE FROM users").run();
}

describe("auth", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("createUser first user becomes admin", () => {
    const user = createUser("admin1", "pass123");
    assert.equal(user.role, "admin");
    assert.equal(user.username, "admin1");
  });

  it("createUser subsequent users are pending", () => {
    createUser("admin1", "pass123");
    const user2 = createUser("user2", "pass456");
    assert.equal(user2.role, "pending");
  });

  it("verifyUser correct password returns user", () => {
    createUser("testuser", "secret");
    const user = verifyUser("testuser", "secret");
    assert.ok(user);
    assert.equal(user.username, "testuser");
  });

  it("verifyUser wrong password returns null", () => {
    createUser("testuser", "secret");
    const user = verifyUser("testuser", "wrong");
    assert.equal(user, null);
  });

  it("verifyUser nonexistent user returns null", () => {
    const user = verifyUser("ghost", "pass");
    assert.equal(user, null);
  });

  it("getUser returns user by id", () => {
    const created = createUser("lookup", "pass");
    const found = getUser(created.id);
    assert.ok(found);
    assert.equal(found.username, "lookup");
  });

  it("getUserByUsername returns user", () => {
    createUser("findme", "pass");
    const found = getUserByUsername("findme");
    assert.ok(found);
    assert.equal(found.username, "findme");
  });

  it("listUsers returns all users", () => {
    createUser("u1", "p1");
    createUser("u2", "p2");
    const users = listUsers();
    assert.equal(users.length, 2);
  });

  it("listPendingUsers returns only pending", () => {
    createUser("admin", "p1"); // admin
    createUser("pending1", "p2"); // pending
    createUser("pending2", "p3"); // pending
    const pending = listPendingUsers();
    assert.equal(pending.length, 2);
    assert.ok(pending.every((u) => u.role === "pending"));
  });

  it("approveUser changes role from pending to user", () => {
    createUser("admin", "p1");
    const pending = createUser("newuser", "p2");
    assert.equal(pending.role, "pending");
    approveUser(pending.id);
    const approved = getUser(pending.id);
    assert.ok(approved);
    assert.equal(approved.role, "user");
  });
});
