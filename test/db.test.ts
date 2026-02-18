import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getDb } from "../src/lib/db.js";
import { conversations, messages, users } from "../src/lib/schema.js";

describe("database", () => {
  it("getDb connects and returns a Drizzle instance", async () => {
    const db = await getDb();
    assert.ok(db);
    // Should be able to run a simple query
    const result = await db.select().from(users).limit(0).all();
    assert.ok(Array.isArray(result));
  });

  it("schema has expected tables with correct columns", () => {
    // Users table
    const userCols = Object.keys(users);
    assert.ok(userCols.includes("id"));
    assert.ok(userCols.includes("username"));
    assert.ok(userCols.includes("password_hash"));
    assert.ok(userCols.includes("role"));
    assert.ok(userCols.includes("created_at"));

    // Conversations table
    const convCols = Object.keys(conversations);
    assert.ok(convCols.includes("id"));
    assert.ok(convCols.includes("mind_name"));
    assert.ok(convCols.includes("channel"));
    assert.ok(convCols.includes("user_id"));
    assert.ok(convCols.includes("title"));

    // Messages table
    const msgCols = Object.keys(messages);
    assert.ok(msgCols.includes("id"));
    assert.ok(msgCols.includes("conversation_id"));
    assert.ok(msgCols.includes("role"));
    assert.ok(msgCols.includes("content"));
  });

  it("getDb returns same singleton on repeated calls", async () => {
    const db1 = await getDb();
    const db2 = await getDb();
    assert.strictEqual(db1, db2);
  });

  it("tables exist in the database", async () => {
    const db = await getDb();
    // Verify all three tables exist by querying them
    const usersResult = await db.select().from(users).limit(0).all();
    assert.ok(Array.isArray(usersResult));

    const convsResult = await db.select().from(conversations).limit(0).all();
    assert.ok(Array.isArray(convsResult));

    const msgsResult = await db.select().from(messages).limit(0).all();
    assert.ok(Array.isArray(msgsResult));
  });
});
