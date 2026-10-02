import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { createUser } from "../packages/daemon/src/lib/auth.js";
import { readBridgesConfig, setBridgeConfig } from "../packages/daemon/src/lib/bridges/bridges.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { voluteSystemDir } from "../packages/daemon/src/lib/mind/registry.js";
import { users } from "../packages/daemon/src/lib/schema.js";
import { createSession } from "../packages/daemon/src/web/middleware/auth.js";

// #1352 review: a stop reads, signals and removes `bridges/<platform>.pid` with daemon
// (root) privileges, so DELETE must refuse any platform that isn't a known bridge
// before the manager sees it — `..%2Fevil` would otherwise reach a PID file anywhere.

const ADMIN = "bridges-api-admin";
let cookie: string;

describe("bridge routes refuse unknown platforms", () => {
  before(async () => {
    const db = await getDb();
    await db.delete(users).where(eq(users.username, ADMIN));
    const admin = await createUser(ADMIN, "pass");
    await db.update(users).set({ role: "admin" }).where(eq(users.id, admin.id));
    cookie = await createSession(admin.id);
  });

  after(async () => {
    const db = await getDb();
    await db.delete(users).where(eq(users.username, ADMIN));
    rmSync(resolve(voluteSystemDir(), "bridges.json"), { force: true });
  });

  for (const platform of ["..%2Fevil", "constructor"]) {
    it(`DELETE refuses ${platform} before reaching the bridge manager`, async () => {
      const { default: app } = await import("../packages/daemon/src/web/app.js");
      const res = await app.request(`http://localhost/api/v1/bridges/${platform}`, {
        method: "DELETE",
        headers: { Cookie: `volute_session=${cookie}`, Origin: "http://localhost" },
      });
      // No manager is initialised in this file: anything past the check answers 503.
      assert.equal(res.status, 400, await res.text());
    });
  }

  // #1362: a stale entry for a platform that isn't (or is no longer) built in can still be
  // removed — from the config only, never reaching the manager or a PID path.
  it("DELETE removes an unknown platform's own bridges.json entry without the manager", async () => {
    const entry = { enabled: true, defaultMind: "m", channelMappings: {} };
    setBridgeConfig("retired-platform", entry);
    setBridgeConfig("discord", entry);
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request("http://localhost/api/v1/bridges/retired-platform", {
      method: "DELETE",
      headers: { Cookie: `volute_session=${cookie}`, Origin: "http://localhost" },
    });
    // 200, not 503: the manager (uninitialised here) was never asked.
    assert.equal(res.status, 200, await res.text());
    assert.deepEqual(Object.keys(readBridgesConfig()), ["discord"]);
  });

  it("DELETE still refuses an unknown platform with no entry", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request("http://localhost/api/v1/bridges/never-configured", {
      method: "DELETE",
      headers: { Cookie: `volute_session=${cookie}`, Origin: "http://localhost" },
    });
    assert.equal(res.status, 400, await res.text());
  });

  // The mappings routes key bridges.json by platform: a prototype key must not get in.
  const mappingRoutes: [string, string, (p: string) => string, object?][] = [
    [
      "PUT",
      "PUT",
      (p) => `/api/v1/bridges/${p}/mappings`,
      { externalChannel: "x", voluteChannel: "y" },
    ],
    ["DELETE", "DELETE", (p) => `/api/v1/bridges/${p}/mappings/x`],
    ["GET", "GET", (p) => `/api/v1/bridges/${p}/mappings`],
  ];
  for (const [label, method, path, body] of mappingRoutes) {
    for (const platform of ["__proto__", "constructor"]) {
      it(`${label} mappings refuses ${platform}`, async () => {
        const { default: app } = await import("../packages/daemon/src/web/app.js");
        const res = await app.request(`http://localhost${path(platform)}`, {
          method,
          headers: {
            Cookie: `volute_session=${cookie}`,
            Origin: "http://localhost",
            ...(body && { "Content-Type": "application/json" }),
          },
          ...(body && { body: JSON.stringify(body) }),
        });
        const text = await res.text();
        assert.equal(res.status, 400, text);
        // Refused as unknown — not merely tripping over the prototype on the way in.
        assert.match(text, /Unknown bridge platform/);
        assert.equal(({} as Record<string, unknown>).channelMappings, undefined);
      });
    }
  }
});
