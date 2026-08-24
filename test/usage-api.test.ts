import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createUser, getOrCreateMindUser, setUserRole } from "../packages/daemon/src/lib/auth.js";
import { generateMindToken } from "../packages/daemon/src/lib/daemon/mind-tokens.js";
import type { UsageReport } from "../packages/daemon/src/lib/daemon/usage-report.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { addMind, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import { mindHistory } from "../packages/daemon/src/lib/schema.js";
import { createSession } from "../packages/daemon/src/web/middleware/auth.js";

const PORT_BASE = 4840;
let portOffset = 0;

async function makeMind(name: string): Promise<string> {
  await addMind(name, PORT_BASE + portOffset++);
  await getOrCreateMindUser(name);
  return generateMindToken(name);
}

async function adminSession(username: string): Promise<string> {
  const user = await createUser(username, "pw-123456");
  await setUserRole(user.id, "admin");
  return createSession(user.id);
}

async function seedUsage(mind: string, costUsd: number | null): Promise<void> {
  const db = await getDb();
  await db.insert(mindHistory).values({
    mind,
    type: "usage",
    metadata: JSON.stringify({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 0,
      model: "anthropic:claude-haiku-4-5",
      cost_usd: costUsd,
    }),
  });
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe("GET /api/v1/usage", () => {
  it("reports every mind's spend to an admin", async () => {
    const stamp = Date.now();
    const mind = `usage-api-all-${stamp}`;
    await makeMind(mind);
    await seedUsage(mind, 0.42);
    const session = await adminSession(`usage-api-admin-${stamp}`);
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    try {
      const res = await app.request("http://localhost/api/v1/usage", { headers: auth(session) });
      assert.equal(res.status, 200);
      const body = (await res.json()) as UsageReport & { system: unknown };
      assert.equal(body.window, "24h");
      assert.equal(body.series.length, 24);
      assert.ok("system" in body, "the install-wide bucket is reported, even as null");
      const row = body.minds.find((m) => m.mind === mind);
      assert.ok(row, "the seeded mind appears in the per-mind array");
      assert.equal(row.costUsd, 0.42);
      assert.equal(row.turns, 1);
      assert.equal(row.cacheHitRatio, 0.8);
    } finally {
      await removeMind(mind);
    }
  });

  it("refuses a mind — one mind's costs are not another's business", async () => {
    const stamp = Date.now();
    const mind = `usage-api-nosy-${stamp}`;
    const token = await makeMind(mind);
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    try {
      const res = await app.request("http://localhost/api/v1/usage", { headers: auth(token) });
      assert.equal(res.status, 403);
    } finally {
      await removeMind(mind);
    }
  });

  it("refuses an unauthenticated caller", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request("http://localhost/api/v1/usage");
    assert.equal(res.status, 401);
  });

  it("400s on a window it does not have, rather than answering a different question", async () => {
    const session = await adminSession(`usage-api-window-${Date.now()}`);
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request("http://localhost/api/v1/usage?window=90d", {
      headers: auth(session),
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /window/i);
  });

  it("accepts the wider windows", async () => {
    const session = await adminSession(`usage-api-wide-${Date.now()}`);
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    for (const [window, buckets] of [
      ["7d", 7],
      ["30d", 30],
    ] as const) {
      const res = await app.request(`http://localhost/api/v1/usage?window=${window}`, {
        headers: auth(session),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as UsageReport;
      assert.equal(body.window, window);
      assert.equal(body.series.length, buckets);
      assert.equal(body.bucketMinutes, 1440);
    }
  });
});

describe("GET /api/v1/minds/:name/usage", () => {
  it("lets a mind read its own usage", async () => {
    const mind = `usage-api-self-${Date.now()}`;
    const token = await makeMind(mind);
    await seedUsage(mind, 0.11);
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    try {
      const res = await app.request(`http://localhost/api/v1/minds/${mind}/usage`, {
        headers: auth(token),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as UsageReport;
      assert.deepEqual(
        body.minds.map((m) => m.mind),
        [mind],
        "scoped to this mind alone",
      );
      assert.equal(body.total.costUsd, 0.11);
    } finally {
      await removeMind(mind);
    }
  });

  it("reports unpriced turns so the figure reads as a floor", async () => {
    const mind = `usage-api-floor-${Date.now()}`;
    const token = await makeMind(mind);
    await seedUsage(mind, 0.05);
    await seedUsage(mind, null);
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    try {
      const res = await app.request(`http://localhost/api/v1/minds/${mind}/usage`, {
        headers: auth(token),
      });
      const body = (await res.json()) as UsageReport;
      assert.equal(body.total.turns, 2);
      assert.equal(body.total.costUsd, 0.05);
      assert.equal(body.total.unpricedTurns, 1);
    } finally {
      await removeMind(mind);
    }
  });

  it("refuses another mind's token — requireSelf boundary", async () => {
    const stamp = Date.now();
    const target = `usage-api-target-${stamp}`;
    const other = `usage-api-other-${stamp}`;
    await makeMind(target);
    const otherToken = await makeMind(other);
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    try {
      const res = await app.request(`http://localhost/api/v1/minds/${target}/usage`, {
        headers: auth(otherToken),
      });
      assert.equal(res.status, 403);
    } finally {
      await removeMind(target);
      await removeMind(other);
    }
  });

  it("400s on an unknown window", async () => {
    const mind = `usage-api-selfwindow-${Date.now()}`;
    const token = await makeMind(mind);
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    try {
      const res = await app.request(`http://localhost/api/v1/minds/${mind}/usage?window=forever`, {
        headers: auth(token),
      });
      assert.equal(res.status, 400);
    } finally {
      await removeMind(mind);
    }
  });
});
