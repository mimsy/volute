import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * The API surface is a single canonical prefix, /api/v1. The bare /api aliases
 * were dropped (#333), with two deliberate exceptions kept on the bare prefix:
 * /api/health (liveness, unauthenticated) and the /api/ext/* extension mounts.
 *
 * Two things this pins that would otherwise regress silently:
 *   1. The bare /api/<module> paths now 404 — no leftover dual mounts.
 *   2. The public v1 sub-surfaces (/setup, /auth, /keys) are exempt from the
 *      /api/v1/* auth blanket. Setup runs before the first user exists, so if the
 *      blanket ever swallowed it, first-run install would 401 and dead-end. The
 *      no-credential assertions below FAIL (401 instead of 200/404) the moment
 *      that exemption is removed — that is their whole point.
 */
describe("api prefix surface", () => {
  it("serves the canonical /api/v1/setup without credentials (auth exemption)", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    // No Cookie, no Authorization header at all.
    const res = await app.request("/api/v1/setup/status");
    // Reachable → the setup handler answered. If the v1 auth blanket were not
    // exempting /setup, this would be 401 before the handler ran.
    assert.equal(res.status, 200);
    const body = (await res.json()) as { complete?: boolean };
    assert.equal(typeof body.complete, "boolean");
  });

  it("serves public /api/v1/auth routes without credentials (auth exemption)", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    // A public avatar read for a missing file: reachable → 404 from the handler.
    // If /auth were behind the v1 auth blanket, this would be 401 instead.
    const res = await app.request("/api/v1/auth/avatars/does-not-exist.png");
    assert.notEqual(res.status, 401);
    assert.equal(res.status, 404);
  });

  it("keeps /api/health on the bare prefix, unauthenticated", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request("/api/health");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok?: boolean };
    assert.equal(body.ok, true);
  });

  it("404s the dropped bare /api/<module> aliases (one per former mount group)", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    // One representative route per former bare-mount group. All moved to /api/v1.
    const barePaths = [
      "/api/setup/status", // setup (was pre-auth bare mount)
      "/api/auth/me", // auth
      "/api/config/models", // config
      "/api/backup/status", // backup (admin tooling)
      "/api/bridges", // bridges
      "/api/minds", // mind-scoped modules
      "/api/keys/deadbeef", // keys
      "/api/extensions/all", // extensions management
    ];
    for (const path of barePaths) {
      const res = await app.request(path);
      assert.equal(res.status, 404, `expected 404 for dropped bare path ${path}`);
    }
  });
});
