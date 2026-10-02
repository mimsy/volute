import assert from "node:assert/strict";
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { generateIdentity, getFingerprint } from "../packages/daemon/src/lib/mind/identity.js";
import {
  addMind,
  addSpirit,
  mindDir,
  removeMind,
  voluteSystemDir,
} from "../packages/daemon/src/lib/mind/registry.js";

const TEST_MIND = `keys-test-${Date.now()}`;

describe("web keys routes", () => {
  let publicKeyPem: string;
  let fingerprint: string;

  beforeEach(async () => {
    addMind(TEST_MIND, 4999);
    const dir = mindDir(TEST_MIND);
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    const identity = await generateIdentity(dir);
    publicKeyPem = identity.publicKeyPem;
    fingerprint = getFingerprint(publicKeyPem);
  });

  afterEach(() => {
    const dir = mindDir(TEST_MIND);
    rmSync(dir, { recursive: true, force: true });
    removeMind(TEST_MIND);
  });

  it("GET /:fingerprint — returns public key for matching fingerprint", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request(`/api/v1/keys/${fingerprint}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.publicKey, publicKeyPem);
    assert.equal(body.mind, TEST_MIND);
  });

  it("GET /:fingerprint — returns 404 for unknown fingerprint", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request(
      "/api/v1/keys/0000000000000000000000000000000000000000000000000000000000000000",
    );
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error);
  });

  it("GET /:fingerprint — works without authentication", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    // No Cookie header — should still work
    const res = await app.request(`/api/v1/keys/${fingerprint}`);
    assert.equal(res.status, 200);
  });

  // The route is unauthenticated and reads as the daemon: a public.pem the mind swapped
  // for a link is skipped, not followed (#1264).
  it("GET /:fingerprint — skips a key file the mind replaced with a link", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const keyPath = resolve(mindDir(TEST_MIND), ".mind/identity/public.pem");
    const elsewhere = resolve(mindDir(TEST_MIND), "elsewhere.pem");
    renameSync(keyPath, elsewhere);
    symlinkSync(elsewhere, keyPath);

    const res = await app.request(`/api/v1/keys/${fingerprint}`);
    assert.equal(res.status, 404);
  });

  // The spirit lives outside the minds dir; its key is found through its registry dir.
  it("GET /:fingerprint — finds a key in a mind whose dir is not under the minds dir", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const name = `keys-spirit-${Date.now()}`;
    const dir = resolve(voluteSystemDir(), name);
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    writeFileSync(resolve(dir, "home/.config/volute.json"), "{}");
    await addSpirit(name, 4998, "claude", dir);
    try {
      const { publicKeyPem: pem } = await generateIdentity(dir);
      const res = await app.request(`/api/v1/keys/${getFingerprint(pem)}`);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).mind, name);
    } finally {
      await removeMind(name);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
