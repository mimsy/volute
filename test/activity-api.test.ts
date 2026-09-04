import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getOrCreateMindUser } from "../packages/daemon/src/lib/auth.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { publish } from "../packages/daemon/src/lib/events/activity-events.js";
import { activity } from "../packages/daemon/src/lib/schema.js";
import activityRoutes from "../packages/daemon/src/web/api/activity.js";
import { authMiddleware, createSession, type AuthEnv } from "../packages/daemon/src/web/middleware/auth.js";

const app = new Hono<AuthEnv>().use("*", authMiddleware).route("/activity", activityRoutes);

async function openActivityStream(session: string) {
  const res = await app.request("/activity/events", {
    headers: { Authorization: `Bearer ${session}` },
  });
  assert.equal(res.status, 200);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<Record<string, any>> = [];
  let buffer = "";
  let active = true;
  const loop = (async () => {
    try {
      while (active) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const end = buffer.indexOf("\n\n");
          if (end === -1) break;
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
          if (!dataLine) continue;
          const payload = dataLine.slice(dataLine.indexOf(":") + 1).trim();
          if (payload) events.push(JSON.parse(payload));
        }
      }
    } catch {
      // The stream is expected to reject its read when the test closes it.
    }
  })();

  return {
    events,
    async close() {
      active = false;
      await reader.cancel();
      await loop;
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), "timed out waiting for activity event");
}

describe("legacy activity SSE authorization", () => {
  it("scopes both the snapshot and live events to the caller's mind", async () => {
    const alice = await getOrCreateMindUser("legacy-activity-alice");
    await getOrCreateMindUser("legacy-activity-bob");
    const session = await createSession(alice.id);
    const db = await getDb();

    await db.insert(activity).values([
      { type: "mind_done", mind: alice.username, summary: "alice-visible" },
      { type: "mind_done", mind: "legacy-activity-bob", summary: "bob-secret" },
    ]);

    const stream = await openActivityStream(session);
    try {
      await waitFor(() => stream.events.some((event) => event.event === "snapshot"));
      const snapshot = stream.events.find((event) => event.event === "snapshot")!;
      assert.ok(snapshot.activity.some((row: { mind: string }) => row.mind === alice.username));
      assert.ok(snapshot.activity.every((row: { mind: string }) => row.mind === alice.username));
      assert.ok(!JSON.stringify(snapshot.activity).includes("bob-secret"));

      await publish({
        type: "mind_done",
        mind: "legacy-activity-bob",
        summary: "bob-live-secret",
      });
      await publish({
        type: "mind_done",
        mind: alice.username,
        summary: "alice-live-visible",
      });
      await waitFor(() => stream.events.some((event) => event.summary === "alice-live-visible"));

      const liveActivity = stream.events.filter((event) => event.event === "activity");
      assert.ok(liveActivity.some((event) => event.summary === "alice-live-visible"));
      assert.ok(!liveActivity.some((event) => event.summary === "bob-live-secret"));
    } finally {
      await stream.close();
      await db.delete(activity).where(eq(activity.mind, alice.username));
      await db.delete(activity).where(eq(activity.mind, "legacy-activity-bob"));
    }
  });
});
