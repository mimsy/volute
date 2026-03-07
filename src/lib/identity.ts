import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import log from "./logger.js";
import { readSystemsConfig } from "./systems-config.js";
import { readVoluteConfig, writeVoluteConfig } from "./volute-config.js";

/** Generate an Ed25519 keypair and write to .mind/identity/ */
export function generateIdentity(mindDir: string): { publicKeyPem: string; privateKeyPem: string } {
  const identityDir = resolve(mindDir, ".mind/identity");
  mkdirSync(identityDir, { recursive: true });

  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const privatePath = resolve(identityDir, "private.pem");
  const publicPath = resolve(identityDir, "public.pem");

  writeFileSync(privatePath, privateKey, { mode: 0o600 });
  writeFileSync(publicPath, publicKey, { mode: 0o644 });

  // Record paths in volute.json
  const config = readVoluteConfig(mindDir) ?? {};
  config.identity = {
    privateKey: ".mind/identity/private.pem",
    publicKey: ".mind/identity/public.pem",
  };
  writeVoluteConfig(mindDir, config);

  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

/** Read the private key PEM from disk */
export function getPrivateKey(mindDir: string): string | null {
  const config = readVoluteConfig(mindDir);
  const relPath = config?.identity?.privateKey;
  if (!relPath) return null;
  const fullPath = resolve(mindDir, relPath);
  if (!existsSync(fullPath)) return null;
  return readFileSync(fullPath, "utf-8");
}

/** Read the public key PEM from disk */
export function getPublicKey(mindDir: string): string | null {
  const config = readVoluteConfig(mindDir);
  const relPath = config?.identity?.publicKey;
  if (!relPath) return null;
  const fullPath = resolve(mindDir, relPath);
  if (!existsSync(fullPath)) return null;
  return readFileSync(fullPath, "utf-8");
}

/** SHA-256 hex fingerprint of a public key PEM */
export function getFingerprint(publicKeyPem: string): string {
  return createHash("sha256").update(publicKeyPem).digest("hex");
}

/** Sign message content + timestamp with an Ed25519 private key */
export function signMessage(privateKeyPem: string, content: string, timestamp: string): string {
  const data = `${content}\n${timestamp}`;
  const signature = sign(null, Buffer.from(data), privateKeyPem);
  return signature.toString("base64");
}

/** Verify an Ed25519 signature */
export function verifySignature(
  publicKeyPem: string,
  content: string,
  timestamp: string,
  signature: string,
): boolean {
  try {
    const data = `${content}\n${timestamp}`;
    return verify(null, Buffer.from(data), publicKeyPem, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

/** Publish public key to volute.systems (non-fatal on failure) */
export async function publishPublicKey(mindName: string, publicKeyPem: string): Promise<boolean> {
  const systems = readSystemsConfig();
  if (!systems) return false;

  try {
    const res = await fetch(`${systems.apiUrl}/api/keys/${encodeURIComponent(mindName)}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${systems.apiKey}`,
      },
      body: JSON.stringify({ publicKey: publicKeyPem }),
    });
    if (!res.ok) {
      log.warn(`failed to publish key for ${mindName}: ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    log.warn(`failed to publish key for ${mindName}`, log.errorData(err));
    return false;
  }
}
