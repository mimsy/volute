import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { createUser } from "../packages/daemon/src/lib/auth.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
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
