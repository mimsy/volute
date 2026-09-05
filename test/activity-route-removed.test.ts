import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { createUser, getOrCreateMindUser } from "../packages/daemon/src/lib/auth.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { users } from "../packages/daemon/src/lib/schema.js";
import { createSession, deleteSession } from "../packages/daemon/src/web/middleware/auth.js";

/**
 * GET /api/v1/activity/events was an unscoped sibling of /api/v1/events: it
 * returned the whole global `activity` table plus a firehose subscription to
 * anyone past authMiddleware, minds included (#1032). It had no consumer left —
 * the frontend subscribes to /api/v1/events — so it was deleted along with its
 * module and its mount.
 *
 * These assertions authenticate deliberately. An unauthenticated request to a
 * missing /api/v1 path is answered 401 by the auth blanket before routing, so
 * only an authenticated 404 distinguishes "not mounted" from "merely gated" —
 * i.e. only an authenticated 404 would fail if someone re-added the route.
 */
describe("removed /api/v1/activity/events route (#1032)", () => {
  const ADMIN = "activity-route-admin";
  const MIND = "activity-route-mind";
  const sessions: string[] = [];

  afterEach(async () => {
    for (const s of sessions.splice(0)) await deleteSession(s);
    const db = await getDb();
    for (const u of [ADMIN, MIND]) await db.delete(users).where(eq(users.username, u));
  });

  async function adminCookie(): Promise<string> {
    const user = await createUser(ADMIN, "pass");
    const id = await createSession(user.id);
    sessions.push(id);
    return id;
  }

  /** A mind user is role "user" — the principal the leak was reachable from. */
  async function mindCookie(name: string): Promise<string> {
    const user = await getOrCreateMindUser(name);
    const id = await createSession(user.id);
    sessions.push(id);
    return id;
  }

  it("404s for an authenticated admin and for a non-admin mind", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    for (const cookie of [await adminCookie(), await mindCookie(MIND)]) {
      const res = await app.request("/api/v1/activity/events", {
        headers: { Cookie: `volute_session=${cookie}` },
      });
      assert.equal(res.status, 404, "GET /api/v1/activity/events must stay unmounted");
    }
  });

  it("still serves the scoped sibling /api/v1/events (control)", async () => {
    // Without this, an app that 404s everything would pass the test above.
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const cookie = await adminCookie();
    const res = await app.request("/api/v1/events", {
      headers: { Cookie: `volute_session=${cookie}`, Accept: "text/event-stream" },
    });
    assert.notEqual(res.status, 404, "/api/v1/events is the surviving, self-scoped stream");
    await res.body?.cancel();
  });
});
