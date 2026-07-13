import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { createUser } from "../packages/daemon/src/lib/auth.js";
import { getScheduler, initScheduler } from "../packages/daemon/src/lib/daemon/scheduler.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { addMind, removeMind, voluteHome } from "../packages/daemon/src/lib/mind/registry.js";
import type { Schedule } from "../packages/daemon/src/lib/mind/volute-config.js";
import { users } from "../packages/daemon/src/lib/schema.js";
import { createSession } from "../packages/daemon/src/web/middleware/auth.js";

// writeSchedules reloads the scheduler after each mutation
try {
  getScheduler();
} catch {
  initScheduler();
}

const mindName = `sched-test-${process.pid}`;
let cookie: string;

async function cleanup() {
  const db = await getDb();
  await db.delete(users).where(eq(users.username, "sched-admin"));
  await removeMind(mindName);
}

function jsonHeaders() {
  return {
    Cookie: `volute_session=${cookie}`,
    Origin: "http://localhost",
    "Content-Type": "application/json",
  };
}

async function getApp() {
  const { default: app } = await import("../packages/daemon/src/web/app.js");
  return app;
}

async function fetchSchedules(): Promise<Schedule[]> {
  const app = await getApp();
  const res = await app.request(`/api/minds/${mindName}/schedules`, {
    headers: { Cookie: `volute_session=${cookie}` },
  });
  assert.equal(res.status, 200);
  return (await res.json()) as Schedule[];
}

async function postSchedule(body: Record<string, unknown>) {
  const app = await getApp();
  return app.request(`/api/minds/${mindName}/schedules`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
}

async function putSchedule(id: string, body: Record<string, unknown>) {
  const app = await getApp();
  return app.request(`/api/minds/${mindName}/schedules/${id}`, {
    method: "PUT",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
}

describe("schedules API rotating messages", () => {
  beforeEach(async () => {
    await cleanup();
    const user = await createUser("sched-admin", "pass");
    cookie = await createSession(user.id);
    await addMind(mindName, 4198);
    const dir = resolve(voluteHome(), "minds", mindName);
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    writeFileSync(resolve(dir, "home/.config/volute.json"), "{}\n");
  });
  afterEach(cleanup);

  it("POST accepts and persists a messages pool", async () => {
    const res = await postSchedule({
      id: "heartbeat",
      cron: "0 12 * * *",
      messages: ["first", "second"],
    });
    assert.equal(res.status, 201);

    const schedules = await fetchSchedules();
    assert.equal(schedules.length, 1);
    assert.deepEqual(schedules[0].messages, ["first", "second"]);
    assert.equal(schedules[0].message, undefined);
  });

  it("POST rejects message + messages together", async () => {
    const res = await postSchedule({
      id: "hb",
      cron: "0 12 * * *",
      message: "solo",
      messages: ["a", "b"],
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("mutually exclusive"));
  });

  it("POST rejects malformed messages", async () => {
    for (const messages of ["not-an-array", ["ok", ""], ["ok", "   "], [42]]) {
      const res = await postSchedule({ id: "hb", cron: "0 12 * * *", messages });
      assert.equal(res.status, 400, `expected 400 for messages=${JSON.stringify(messages)}`);
      const body = (await res.json()) as { error: string };
      assert.ok(body.error.includes("messages"));
    }
  });

  it("PUT keeps at most one action field", async () => {
    assert.equal(
      (await postSchedule({ id: "hb", cron: "0 12 * * *", messages: ["a", "b"] })).status,
      201,
    );

    // messages → message
    assert.equal((await putSchedule("hb", { message: "solo" })).status, 200);
    let [sched] = await fetchSchedules();
    assert.equal(sched.message, "solo");
    assert.equal(sched.messages, undefined);

    // message → messages
    assert.equal((await putSchedule("hb", { messages: ["x", "y"] })).status, 200);
    [sched] = await fetchSchedules();
    assert.deepEqual(sched.messages, ["x", "y"]);
    assert.equal(sched.message, undefined);

    // messages → script
    assert.equal((await putSchedule("hb", { script: "echo hi" })).status, 200);
    [sched] = await fetchSchedules();
    assert.equal(sched.script, "echo hi");
    assert.equal(sched.message, undefined);
    assert.equal(sched.messages, undefined);
  });

  it("PUT rejects edits that would leave the schedule actionless", async () => {
    assert.equal(
      (await postSchedule({ id: "hb", cron: "0 12 * * *", messages: ["a", "b"] })).status,
      201,
    );

    // Clearing the pool with nothing to replace it → 400, schedule unchanged
    const res = await putSchedule("hb", { messages: [] });
    assert.equal(res.status, 400);
    let [sched] = await fetchSchedules();
    assert.deepEqual(sched.messages, ["a", "b"]);

    // Clearing the pool while providing a replacement action is fine
    assert.equal((await putSchedule("hb", { messages: [], message: "solo" })).status, 200);
    [sched] = await fetchSchedules();
    assert.equal(sched.message, "solo");
    assert.equal(sched.messages, undefined);

    // A non-action edit on an action-bearing schedule still works
    assert.equal((await putSchedule("hb", { enabled: false })).status, 200);
    [sched] = await fetchSchedules();
    assert.equal(sched.enabled, false);
    assert.equal(sched.message, "solo");
  });

  it("POST and PUT persist the thread target", async () => {
    // POST persists thread (the scheduler fires it into that thread — see
    // scheduler.test.ts "fire passes session from schedule config").
    const res = await postSchedule({
      id: "dream",
      cron: "0 3 * * *",
      message: "you are dreaming",
      thread: "$new",
    });
    assert.equal(res.status, 201);
    let [sched] = await fetchSchedules();
    assert.equal(sched.thread, "$new");

    // PUT updates it
    assert.equal((await putSchedule("dream", { thread: "dreams" })).status, 200);
    [sched] = await fetchSchedules();
    assert.equal(sched.thread, "dreams");

    // PUT with an empty string clears it
    assert.equal((await putSchedule("dream", { thread: "" })).status, 200);
    [sched] = await fetchSchedules();
    assert.equal(sched.thread, undefined);
  });
});
