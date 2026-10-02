import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { createUser } from "../packages/daemon/src/lib/auth.js";
import { getScheduler, initScheduler } from "../packages/daemon/src/lib/daemon/scheduler.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { readRoutesConfig } from "../packages/daemon/src/lib/mind/event-routes.js";
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
  const res = await app.request(`/api/v1/minds/${mindName}/schedules`, {
    headers: { Cookie: `volute_session=${cookie}` },
  });
  assert.equal(res.status, 200);
  return (await res.json()) as Schedule[];
}

async function postSchedule(body: Record<string, unknown>) {
  const app = await getApp();
  return app.request(`/api/v1/minds/${mindName}/schedules`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
}

async function putSchedule(id: string, body: Record<string, unknown>) {
  const app = await getApp();
  return app.request(`/api/v1/minds/${mindName}/schedules/${id}`, {
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

  // A mind's parallel tool calls: each add is one read-modify-write of volute.json, so
  // none can drop another's schedule; a duplicate id still conflicts.
  it("parallel POSTs all land, and a duplicate id still gets 409", async () => {
    const results = await Promise.all(
      ["p1", "p2", "p3", "p4", "p1"].map((id) =>
        postSchedule({ id, cron: "0 9 * * *", message: id }),
      ),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 201, 201, 201, 409]);
    const ids = (await fetchSchedules()).map((s) => s.id);
    for (const id of ["p1", "p2", "p3", "p4"]) assert.ok(ids.includes(id), id);
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
      // A malformed *type* (non-array, non-string element) now trips the zValidator
      // schema → structured zod 400 (`success: false`). A present-but-empty/whitespace
      // element still trips the in-handler validateMessages → `{ error: "…messages…" }`.
      // Both are 400s about `messages`; accept either shape.
      const body = (await res.json()) as { success?: boolean; error?: unknown };
      assert.ok(
        body.success === false ||
          (typeof body.error === "string" && body.error.includes("messages")),
        `expected a messages validation error, got ${JSON.stringify(body)}`,
      );
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

  it("POST/PUT --thread is sugar for a routes.json event rule (#736)", async () => {
    // `--thread` no longer lives on the schedule — it writes a routes.json event rule so
    // schedule-fire routing lives in one place. The schedule row itself carries no thread.
    const dir = resolve(voluteHome(), "minds", mindName);
    const ruleThread = async () =>
      (await readRoutesConfig(dir, null)).rules?.find((r) => r.event === "schedule:dream")?.thread;

    const res = await postSchedule({
      id: "dream",
      cron: "0 3 * * *",
      message: "you are dreaming",
      thread: "$new",
    });
    assert.equal(res.status, 201);
    const [sched] = await fetchSchedules();
    assert.equal(sched.thread, undefined);
    assert.equal(await ruleThread(), "$new");

    // PUT updates the rule
    assert.equal((await putSchedule("dream", { thread: "dreams" })).status, 200);
    assert.equal(await ruleThread(), "dreams");

    // PUT with an empty string removes the rule
    assert.equal((await putSchedule("dream", { thread: "" })).status, 200);
    assert.equal(await ruleThread(), undefined);

    // POST it back, then DELETE the schedule — the rule is cleaned up too.
    assert.equal((await putSchedule("dream", { thread: "dreams" })).status, 200);
    assert.equal(await ruleThread(), "dreams");
    const app = await getApp();
    assert.equal(
      (
        await app.request(`/api/v1/minds/${mindName}/schedules/dream`, {
          method: "DELETE",
          headers: jsonHeaders(),
        })
      ).status,
      200,
    );
    assert.equal(await ruleThread(), undefined);
  });
  // A routes.json the mind swapped for a symlink refuses the rule write (#1260). The
  // request that asked for the thread must then change nothing, and say why (#1273).
  describe("when the routes.json rule cannot be written", () => {
    const dir = () => resolve(voluteHome(), "minds", mindName);
    const routes = () => resolve(dir(), "home/.config/routes.json");
    const outside = () => resolve(dir(), "outside-routes.json");
    const plantLink = () => {
      writeFileSync(outside(), '{"rules":[]}');
      rmSync(routes(), { force: true });
      symlinkSync(outside(), routes());
    };
    const del = async (id: string) =>
      (await getApp()).request(`/api/v1/minds/${mindName}/schedules/${id}`, {
        method: "DELETE",
        headers: jsonHeaders(),
      });

    it("POST with a thread adds no schedule, says why, and a retry succeeds", async () => {
      plantLink();
      const body = { id: "dream", cron: "0 3 * * *", message: "dreaming", thread: "dreams" };
      const res = await postSchedule(body);
      assert.equal(res.status, 500);
      assert.match(((await res.json()) as { error: string }).error, /not added.*routes\.json/);
      assert.deepEqual(await fetchSchedules(), [], "the schedule was rolled back");
      assert.equal(readFileSync(outside(), "utf-8"), '{"rules":[]}', "link target untouched");

      unlinkSync(routes());
      assert.equal((await postSchedule(body)).status, 201, "a retry isn't a duplicate");
      const rules = (await readRoutesConfig(dir(), null)).rules ?? [];
      assert.equal(rules.find((r) => r.event === "schedule:dream")?.thread, "dreams");
    });

    it("PUT with a thread leaves the schedule as it was", async () => {
      assert.equal(
        (
          await postSchedule({
            id: "dream",
            cron: "0 3 * * *",
            message: "old",
            whileSleeping: "queue",
          })
        ).status,
        201,
      );
      const [original] = await fetchSchedules();
      plantLink();
      const res = await putSchedule("dream", {
        message: "new",
        whileSleeping: "skip",
        thread: "dreams",
      });
      assert.equal(res.status, 500);
      assert.match(((await res.json()) as { error: string }).error, /not updated.*routes\.json/);
      assert.deepEqual(await fetchSchedules(), [original], "the edit was rolled back");
    });

    it("PUT clearing a thread keeps the edit and says the rule stayed", async () => {
      assert.equal(
        (await postSchedule({ id: "dream", cron: "0 3 * * *", message: "old" })).status,
        201,
      );
      plantLink();
      const res = await putSchedule("dream", { message: "new", thread: "" });
      assert.equal(res.status, 500);
      assert.match(((await res.json()) as { error: string }).error, /updated, but.*routes\.json/);
      assert.equal((await fetchSchedules())[0].message, "new");
    });

    // Deleting isn't held hostage by a routes.json the mind linked: the schedule goes, and
    // the response says the rule stayed.
    it("DELETE removes the schedule and says the rule stayed", async () => {
      assert.equal(
        (await postSchedule({ id: "dream", cron: "0 3 * * *", message: "m" })).status,
        201,
      );
      plantLink();
      const res = await del("dream");
      assert.equal(res.status, 500);
      assert.match(((await res.json()) as { error: string }).error, /deleted, but.*routes\.json/);
      assert.deepEqual(await fetchSchedules(), []);
    });
  });
});
