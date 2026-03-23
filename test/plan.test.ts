import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Database as ExtDb, User } from "@volute/extensions";
import Database from "libsql";
import { initDb } from "../packages/extensions/plan/src/db.js";
import {
  addPlanMessage,
  finishPlan,
  getActivePlan,
  listPlans,
  logProgress,
  startPlan,
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

  it("startPlan creates a plan", async () => {
    const plan = await startPlan(db, getUser, spiritId, "Build a story", "Collaborative fiction");
    assert.equal(plan.title, "Build a story");
    assert.equal(plan.description, "Collaborative fiction");
    assert.equal(plan.status, "active");
    assert.equal(plan.set_by_username, spiritName);
  });

  it("getActivePlan returns null when no plan", async () => {
    const plan = await getActivePlan(db, getUser);
    assert.equal(plan, null);
  });

  it("getActivePlan returns active plan with logs and messages", async () => {
    const created = await startPlan(db, getUser, spiritId, "Test Plan", "Description");
    logProgress(db, created.id, "aria", "Started work on chapter 1");
    logProgress(db, created.id, "sol", "Drew some illustrations");
    addPlanMessage(db, created.id, "Focus on connecting your wings today");

    const plan = await getActivePlan(db, getUser);
    assert.ok(plan);
    assert.equal(plan.title, "Test Plan");
    assert.equal(plan.logs.length, 2);
    assert.ok(plan.logs.some((l) => l.mind_name === "aria"));
    assert.ok(plan.logs.some((l) => l.mind_name === "sol"));
    assert.equal(plan.messages.length, 1);
    assert.equal(plan.latestMessage, "Focus on connecting your wings today");
  });

  it("starting a new plan archives the previous one", async () => {
    const first = await startPlan(db, getUser, spiritId, "Plan A", "");
    await startPlan(db, getUser, spiritId, "Plan B", "");

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
    await startPlan(db, getUser, spiritId, "Plan 1", "");
    await startPlan(db, getUser, spiritId, "Plan 2", "");
    await startPlan(db, getUser, spiritId, "Plan 3", "");

    const activeRows = (db as any).prepare("SELECT * FROM plans WHERE status = 'active'").all();
    assert.equal(activeRows.length, 1);
    assert.equal(activeRows[0].title, "Plan 3");
  });

  it("finishPlan changes status and stores message", async () => {
    const plan = await startPlan(db, getUser, spiritId, "To Finish", "");
    const ok = finishPlan(db, plan.id, "Great work everyone!");
    assert.ok(ok);

    const active = await getActivePlan(db, getUser);
    assert.equal(active, null);

    const all = await listPlans(db, getUser);
    const finished = all.find((p) => p.id === plan.id);
    assert.ok(finished);
    assert.equal(finished.status, "completed");
    assert.ok(finished.completed_at);
    assert.equal(finished.finish_message, "Great work everyone!");
  });

  it("finishPlan returns false for nonexistent plan", () => {
    const ok = finishPlan(db, 999);
    assert.equal(ok, false);
  });

  it("logProgress adds entries", async () => {
    const plan = await startPlan(db, getUser, spiritId, "With Logs", "");
    const log1 = logProgress(db, plan.id, "aria", "Did thing 1");
    const log2 = logProgress(db, plan.id, "sol", "Did thing 2");

    assert.equal(log1.mind_name, "aria");
    assert.equal(log1.content, "Did thing 1");
    assert.equal(log2.mind_name, "sol");
  });

  it("addPlanMessage tracks messages", async () => {
    const plan = await startPlan(db, getUser, spiritId, "With Messages", "");
    addPlanMessage(db, plan.id, "First focus area");
    addPlanMessage(db, plan.id, "Updated focus area");

    const active = await getActivePlan(db, getUser);
    assert.ok(active);
    assert.equal(active.messages.length, 2);
    assert.equal(active.latestMessage, "Updated focus area");
  });

  it("listPlans filters by status", async () => {
    await startPlan(db, getUser, spiritId, "Old Plan", "");
    await startPlan(db, getUser, spiritId, "Current Plan", "");

    const archived = await listPlans(db, getUser, { status: "archived" });
    assert.equal(archived.length, 1);
    assert.equal(archived[0].title, "Old Plan");

    const active = await listPlans(db, getUser, { status: "active" });
    assert.equal(active.length, 1);
    assert.equal(active[0].title, "Current Plan");
  });

  it("listPlans respects limit and offset", async () => {
    await startPlan(db, getUser, spiritId, "Plan 1", "");
    await startPlan(db, getUser, spiritId, "Plan 2", "");
    await startPlan(db, getUser, spiritId, "Plan 3", "");

    const page = await listPlans(db, getUser, { limit: 1, offset: 1 });
    assert.equal(page.length, 1);
    assert.equal(page[0].title, "Plan 2");
  });

  it("listPlans enriches with user info", async () => {
    registerUser(2, "admin-human");
    await startPlan(db, getUser, 2, "Admin Plan", "");

    const plans = await listPlans(db, getUser);
    assert.equal(plans[0].set_by_username, "admin-human");
  });

  it("finishPlan only finishes active plans", async () => {
    const plan = await startPlan(db, getUser, spiritId, "Plan A", "");
    finishPlan(db, plan.id, "Done");

    // Finishing an already-completed plan should return false
    const ok = finishPlan(db, plan.id, "Done again");
    assert.equal(ok, false);
  });

  it("finishPlan does not finish archived plans", async () => {
    const plan = await startPlan(db, getUser, spiritId, "Old Plan", "");
    // Starting a new plan archives the old one
    await startPlan(db, getUser, spiritId, "New Plan", "");

    const ok = finishPlan(db, plan.id, "Shouldn't work");
    assert.equal(ok, false);
  });

  it("logProgress on invalid plan throws", async () => {
    assert.throws(() => logProgress(db, 99999, "aria", "progress"));
  });

  it("addPlanMessage on invalid plan throws", async () => {
    assert.throws(() => addPlanMessage(db, 99999, "message"));
  });
});
