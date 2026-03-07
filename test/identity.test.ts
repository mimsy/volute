import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  generateIdentity,
  getFingerprint,
  getPrivateKey,
  getPublicKey,
  signMessage,
  verifySignature,
} from "../src/lib/identity.js";

const scratchDir = resolve("/tmp/identity-test");

describe("identity", () => {
  beforeEach(() => {
    mkdirSync(resolve(scratchDir, "home/.config"), { recursive: true });
  });

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  describe("generateIdentity", () => {
    it("creates keypair files in .mind/identity/", () => {
      generateIdentity(scratchDir);

      assert.ok(existsSync(resolve(scratchDir, ".mind/identity/private.pem")));
      assert.ok(existsSync(resolve(scratchDir, ".mind/identity/public.pem")));
    });

    it("returns PEM-encoded keys", () => {
      const { publicKeyPem, privateKeyPem } = generateIdentity(scratchDir);

      assert.ok(publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----"));
      assert.ok(privateKeyPem.startsWith("-----BEGIN PRIVATE KEY-----"));
    });

    it("writes identity paths to volute.json", () => {
      generateIdentity(scratchDir);

      const config = JSON.parse(
        readFileSync(resolve(scratchDir, "home/.config/volute.json"), "utf-8"),
      );
      assert.equal(config.identity.privateKey, ".mind/identity/private.pem");
      assert.equal(config.identity.publicKey, ".mind/identity/public.pem");
    });
  });

  describe("getPrivateKey / getPublicKey", () => {
    it("reads keys after generation", () => {
      const { publicKeyPem, privateKeyPem } = generateIdentity(scratchDir);

      assert.equal(getPrivateKey(scratchDir), privateKeyPem);
      assert.equal(getPublicKey(scratchDir), publicKeyPem);
    });

    it("returns null when no identity configured", () => {
      assert.equal(getPrivateKey(scratchDir), null);
      assert.equal(getPublicKey(scratchDir), null);
    });
  });

  describe("getFingerprint", () => {
    it("returns hex SHA-256 of public key", () => {
      const { publicKeyPem } = generateIdentity(scratchDir);
      const fp = getFingerprint(publicKeyPem);

      assert.match(fp, /^[0-9a-f]{64}$/);
    });

    it("is deterministic", () => {
      const { publicKeyPem } = generateIdentity(scratchDir);

      assert.equal(getFingerprint(publicKeyPem), getFingerprint(publicKeyPem));
    });
  });

  describe("signMessage / verifySignature", () => {
    it("signs and verifies a message", () => {
      const { publicKeyPem, privateKeyPem } = generateIdentity(scratchDir);
      const content = "hello world";
      const timestamp = new Date().toISOString();

      const signature = signMessage(privateKeyPem, content, timestamp);
      assert.ok(verifySignature(publicKeyPem, content, timestamp, signature));
    });

    it("rejects tampered content", () => {
      const { publicKeyPem, privateKeyPem } = generateIdentity(scratchDir);
      const timestamp = new Date().toISOString();

      const signature = signMessage(privateKeyPem, "original", timestamp);
      assert.ok(!verifySignature(publicKeyPem, "tampered", timestamp, signature));
    });

    it("rejects tampered timestamp", () => {
      const { publicKeyPem, privateKeyPem } = generateIdentity(scratchDir);
      const content = "hello";

      const signature = signMessage(privateKeyPem, content, "2026-01-01T00:00:00Z");
      assert.ok(!verifySignature(publicKeyPem, content, "2026-01-02T00:00:00Z", signature));
    });

    it("rejects wrong public key", () => {
      const key1 = generateIdentity(scratchDir);
      // Generate a second keypair
      rmSync(resolve(scratchDir, ".mind/identity"), { recursive: true, force: true });
      const key2 = generateIdentity(scratchDir);

      const content = "hello";
      const timestamp = new Date().toISOString();
      const signature = signMessage(key1.privateKeyPem, content, timestamp);

      assert.ok(!verifySignature(key2.publicKeyPem, content, timestamp, signature));
    });

    it("returns false for invalid signature", () => {
      const { publicKeyPem } = generateIdentity(scratchDir);

      assert.ok(!verifySignature(publicKeyPem, "hello", "now", "not-a-signature"));
    });
  });
});
