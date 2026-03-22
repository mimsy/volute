import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Database as ExtDb, User } from "@volute/extensions";
import Database from "libsql";
import { initDb } from "../packages/extensions/plan/src/db.js";
import {
  completePlan,
  getActivePlan,
  listPlans,
  logProgress,
  setActivePlan,
} from "../packages/extensions/plan/src/plans.js";

let db: ExtDb;
let userMap: Map<number, User>;

async function getUser(id: number): Promise<User | null> {
  return userMap.get(id) ?? null;
}

function registerUser(id: number, username: string): void {
  const user: User = {
    id,
    username,
    role: "admin",
    user_type: "mind",
    display_name: null,
    description: null,
    avatar: null,
  };
  userMap.set(id, user);
}

describe("plan extension", () => {
  const spiritId = 1;
  const spiritName = "volute";

  beforeEach(() => {
    db = new Database(":memory:") as unknown as ExtDb;
    initDb(db);
    userMap = new Map();
    registerUser(spiritId, spiritName);
  });
  afterEach(() => db.close());

  it("setActivePlan creates a plan", async () => {
    const plan = await setActivePlan(
      db,
      getUser,
      spiritId,
      "Build a story",
      "Collaborative fiction",
    );
    assert.equal(plan.title, "Build a story");
    assert.equal(plan.description, "Collaborative fiction");
    assert.equal(plan.status, "active");
    assert.equal(plan.set_by_username, spiritName);
  });

  it("getActivePlan returns null when no plan", async () => {
    const plan = await getActivePlan(db, getUser);
    assert.equal(plan, null);
  });

  it("getActivePlan returns active plan with logs", async () => {
    const created = await setActivePlan(db, getUser, spiritId, "Test Plan", "Description");
    logProgress(db, created.id, "aria", "Started work on chapter 1");
    logProgress(db, created.id, "sol", "Drew some illustrations");

    const plan = await getActivePlan(db, getUser);
    assert.ok(plan);
    assert.equal(plan.title, "Test Plan");
    assert.equal(plan.logs.length, 2);
    // Logs are returned newest first
    assert.ok(plan.logs.some((l) => l.mind_name === "aria"));
    assert.ok(plan.logs.some((l) => l.mind_name === "sol"));
  });

  it("setting a new plan archives the previous one", async () => {
    const first = await setActivePlan(db, getUser, spiritId, "Plan A", "");
    await setActivePlan(db, getUser, spiritId, "Plan B", "");

    const active = await getActivePlan(db, getUser);
    assert.ok(active);
    assert.equal(active.title, "Plan B");

    const all = await listPlans(db, getUser);
    assert.equal(all.length, 2);
    const archived = all.find((p) => p.id === first.id);
    assert.ok(archived);
    assert.equal(archived.status, "archived");
  });

  it("only one active plan at a time", async () => {
    await setActivePlan(db, getUser, spiritId, "Plan 1", "");
    await setActivePlan(db, getUser, spiritId, "Plan 2", "");
    await setActivePlan(db, getUser, spiritId, "Plan 3", "");

    const activeRows = (db as any).prepare("SELECT * FROM plans WHERE status = 'active'").all();
    assert.equal(activeRows.length, 1);
    assert.equal(activeRows[0].title, "Plan 3");
  });

  it("completePlan changes status", async () => {
    const plan = await setActivePlan(db, getUser, spiritId, "To Complete", "");
    const ok = completePlan(db, plan.id);
    assert.ok(ok);

    const active = await getActivePlan(db, getUser);
    assert.equal(active, null);

    const all = await listPlans(db, getUser);
    const completed = all.find((p) => p.id === plan.id);
    assert.ok(completed);
    assert.equal(completed.status, "completed");
    assert.ok(completed.completed_at);
  });

  it("completePlan returns false for nonexistent plan", () => {
    const ok = completePlan(db, 999);
    assert.equal(ok, false);
  });

  it("logProgress adds entries", async () => {
    const plan = await setActivePlan(db, getUser, spiritId, "With Logs", "");
    const log1 = logProgress(db, plan.id, "aria", "Did thing 1");
    const log2 = logProgress(db, plan.id, "sol", "Did thing 2");

    assert.equal(log1.mind_name, "aria");
    assert.equal(log1.content, "Did thing 1");
    assert.equal(log2.mind_name, "sol");
  });

  it("listPlans filters by status", async () => {
    await setActivePlan(db, getUser, spiritId, "Old Plan", "");
    await setActivePlan(db, getUser, spiritId, "Current Plan", "");

    const archived = await listPlans(db, getUser, { status: "archived" });
    assert.equal(archived.length, 1);
    assert.equal(archived[0].title, "Old Plan");

    const active = await listPlans(db, getUser, { status: "active" });
    assert.equal(active.length, 1);
    assert.equal(active[0].title, "Current Plan");
  });

  it("listPlans respects limit and offset", async () => {
    await setActivePlan(db, getUser, spiritId, "Plan 1", "");
    await setActivePlan(db, getUser, spiritId, "Plan 2", "");
    await setActivePlan(db, getUser, spiritId, "Plan 3", "");

    const page = await listPlans(db, getUser, { limit: 1, offset: 1 });
    assert.equal(page.length, 1);
    assert.equal(page[0].title, "Plan 2");
  });

  it("listPlans enriches with user info", async () => {
    registerUser(2, "admin-human");
    await setActivePlan(db, getUser, 2, "Admin Plan", "");

    const plans = await listPlans(db, getUser);
    assert.equal(plans[0].set_by_username, "admin-human");
  });
});
