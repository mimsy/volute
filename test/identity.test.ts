import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  generateIdentity,
  getFingerprint,
  getPrivateKey,
  getPublicKey,
  signMessage,
  verifySignature,
} from "../packages/daemon/src/lib/mind/identity.js";
import {
  readVoluteConfig,
  writeVoluteConfig,
} from "../packages/daemon/src/lib/mind/volute-config.js";

const scratchDir = resolve("/tmp/identity-test");

describe("identity", () => {
  beforeEach(() => {
    mkdirSync(resolve(scratchDir, "home/.config"), { recursive: true });
  });

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  describe("generateIdentity", () => {
    it("creates keypair files in .mind/identity/", async () => {
      await generateIdentity(scratchDir);

      assert.ok(existsSync(resolve(scratchDir, ".mind/identity/private.pem")));
      assert.ok(existsSync(resolve(scratchDir, ".mind/identity/public.pem")));
    });

    it("returns PEM-encoded keys", async () => {
      const { publicKeyPem, privateKeyPem } = await generateIdentity(scratchDir);

      assert.ok(publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----"));
      assert.ok(privateKeyPem.startsWith("-----BEGIN PRIVATE KEY-----"));
    });

    it("writes identity paths to volute.json", async () => {
      await generateIdentity(scratchDir);

      const config = JSON.parse(
        readFileSync(resolve(scratchDir, "home/.config/volute.json"), "utf-8"),
      );
      assert.equal(config.identity.privateKey, ".mind/identity/private.pem");
      assert.equal(config.identity.publicKey, ".mind/identity/public.pem");
    });
  });

  describe("getPrivateKey / getPublicKey", () => {
    it("reads keys after generation", async () => {
      const { publicKeyPem, privateKeyPem } = await generateIdentity(scratchDir);

      assert.equal(await getPrivateKey(scratchDir, null), privateKeyPem);
      assert.equal(await getPublicKey(scratchDir, null), publicKeyPem);
    });

    it("returns null when no identity configured", async () => {
      assert.equal(await getPrivateKey(scratchDir, null), null);
      assert.equal(await getPublicKey(scratchDir, null), null);
    });

    // volute.json is the mind's to edit, and the key route reads as the daemon — root
    // under user isolation, with no auth in front of it (#1264).
    it("refuses a key path out of the mind dir, a link at the name, or a FIFO", async () => {
      await generateIdentity(scratchDir);
      const outside = mkdtempSync(join(tmpdir(), "identity-outside-"));
      try {
        writeFileSync(join(outside, "secret.pem"), "secret");
        const setPath = async (publicKey: string) => {
          const config = readVoluteConfig(scratchDir) ?? {};
          config.identity = { privateKey: ".mind/identity/private.pem", publicKey };
          await writeVoluteConfig(scratchDir, config, null);
        };

        await setPath(join(outside, "secret.pem"));
        await assert.rejects(getPublicKey(scratchDir, null));

        symlinkSync(join(outside, "secret.pem"), resolve(scratchDir, ".mind/identity/linked.pem"));
        await setPath(".mind/identity/linked.pem");
        await assert.rejects(getPublicKey(scratchDir, null), /not a regular file/);

        execFileSync("mkfifo", [resolve(scratchDir, ".mind/identity/fifo.pem")]);
        await setPath(".mind/identity/fifo.pem");
        await assert.rejects(getPublicKey(scratchDir, null), /not a regular file/);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    // volute.json itself is read through the same walk: a config dir linked out of the
    // tree is refused, not followed to whatever volute.json sits at the other end.
    it("refuses a volute.json reached through a linked directory", async () => {
      const { publicKeyPem } = await generateIdentity(scratchDir);
      const outside = mkdtempSync(join(tmpdir(), "identity-outside-"));
      try {
        const config = resolve(scratchDir, "home/.config");
        writeFileSync(join(outside, "volute.json"), readFileSync(join(config, "volute.json")));
        rmSync(config, { recursive: true });
        symlinkSync(outside, config);
        await assert.rejects(getPublicKey(scratchDir, null));

        // The same config in place reads fine — the refusal is the link's.
        rmSync(config);
        mkdirSync(config);
        writeFileSync(join(config, "volute.json"), readFileSync(join(outside, "volute.json")));
        assert.equal(await getPublicKey(scratchDir, null), publicKeyPem);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  describe("getFingerprint", () => {
    it("returns hex SHA-256 of public key", async () => {
      const { publicKeyPem } = await generateIdentity(scratchDir);
      const fp = getFingerprint(publicKeyPem);

      assert.match(fp, /^[0-9a-f]{64}$/);
    });

    it("is deterministic", async () => {
      const { publicKeyPem } = await generateIdentity(scratchDir);

      assert.equal(getFingerprint(publicKeyPem), getFingerprint(publicKeyPem));
    });
  });

  describe("signMessage / verifySignature", () => {
    it("signs and verifies a message", async () => {
      const { publicKeyPem, privateKeyPem } = await generateIdentity(scratchDir);
      const content = "hello world";
      const timestamp = new Date().toISOString();

      const signature = signMessage(privateKeyPem, content, timestamp);
      assert.ok(verifySignature(publicKeyPem, content, timestamp, signature));
    });

    it("rejects tampered content", async () => {
      const { publicKeyPem, privateKeyPem } = await generateIdentity(scratchDir);
      const timestamp = new Date().toISOString();

      const signature = signMessage(privateKeyPem, "original", timestamp);
      assert.ok(!verifySignature(publicKeyPem, "tampered", timestamp, signature));
    });

    it("rejects tampered timestamp", async () => {
      const { publicKeyPem, privateKeyPem } = await generateIdentity(scratchDir);
      const content = "hello";

      const signature = signMessage(privateKeyPem, content, "2026-01-01T00:00:00Z");
      assert.ok(!verifySignature(publicKeyPem, content, "2026-01-02T00:00:00Z", signature));
    });

    it("rejects wrong public key", async () => {
      const key1 = await generateIdentity(scratchDir);
      // Generate a second keypair
      rmSync(resolve(scratchDir, ".mind/identity"), { recursive: true, force: true });
      const key2 = await generateIdentity(scratchDir);

      const content = "hello";
      const timestamp = new Date().toISOString();
      const signature = signMessage(key1.privateKeyPem, content, timestamp);

      assert.ok(!verifySignature(key2.publicKeyPem, content, timestamp, signature));
    });

    it("returns false for invalid signature", async () => {
      const { publicKeyPem } = await generateIdentity(scratchDir);

      assert.ok(!verifySignature(publicKeyPem, "hello", "now", "not-a-signature"));
    });
  });
});
