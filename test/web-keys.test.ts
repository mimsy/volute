import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { addMind, mindDir, removeMind } from "@volute/shared/registry";
import { generateIdentity, getFingerprint } from "../src/lib/identity.js";

const TEST_MIND = `keys-test-${Date.now()}`;

describe("web keys routes", () => {
  let publicKeyPem: string;
  let fingerprint: string;

  beforeEach(() => {
    addMind(TEST_MIND, 4999);
    const dir = mindDir(TEST_MIND);
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    const identity = generateIdentity(dir);
    publicKeyPem = identity.publicKeyPem;
    fingerprint = getFingerprint(publicKeyPem);
  });

  afterEach(() => {
    const dir = mindDir(TEST_MIND);
    rmSync(dir, { recursive: true, force: true });
    removeMind(TEST_MIND);
  });

  it("GET /:fingerprint — returns public key for matching fingerprint", async () => {
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request(`/api/keys/${fingerprint}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.publicKey, publicKeyPem);
    assert.equal(body.mind, TEST_MIND);
  });

  it("GET /:fingerprint — returns 404 for unknown fingerprint", async () => {
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request(
      "/api/keys/0000000000000000000000000000000000000000000000000000000000000000",
    );
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error);
  });

  it("GET /:fingerprint — works without authentication", async () => {
    const { default: app } = await import("../src/web/app.js");

    // No Cookie header — should still work
    const res = await app.request(`/api/keys/${fingerprint}`);
    assert.equal(res.status, 200);
  });
});
