import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { readSystemsConfig } from "../config/systems-config.js";
import log from "../util/logger.js";
import { type MindFileOwner, readMindFile, writeMindFile } from "./mind-file-write.js";
import {
  UnparseableConfigError,
  updateVoluteConfig,
  VOLUTE_JSON,
  type VoluteConfig,
  writeVoluteConfig,
} from "./volute-config.js";

/**
 * Generate an Ed25519 keypair and write to .mind/identity/. Runs on a tree not handed to
 * the mind yet (creation, import), so the writes take no owner — `chownMindDir` follows.
 */
export async function generateIdentity(
  mindDir: string,
): Promise<{ publicKeyPem: string; privateKeyPem: string }> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const owner = null;
  await writeMindFile(mindDir, ".mind/identity/private.pem", privateKey, { owner, mode: 0o600 });
  await writeMindFile(mindDir, ".mind/identity/public.pem", publicKey, { owner, mode: 0o644 });

  // Record paths in volute.json. At creation or import an unparseable one (an archive's)
  // is replaced, as it always was — there is no mind yet whose config it would destroy.
  const identity = {
    privateKey: ".mind/identity/private.pem",
    publicKey: ".mind/identity/public.pem",
  };
  try {
    await updateVoluteConfig(mindDir, owner, (config) => ({ ...config, identity }));
  } catch (err) {
    if (!(err instanceof UnparseableConfigError)) throw err;
    await writeVoluteConfig(mindDir, { identity }, owner);
  }

  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

/**
 * Read a key named by volute.json's `identity`. The path is the mind's to set and the
 * tree is the mind's, while the daemon may be root: read both — volute.json too — through
 * the mind-file helpers,
 * so a path out of the mind dir, a link or a FIFO refuses (throws). Null when no key is
 * configured or the file is absent.
 */
async function readIdentityKey(
  mindDir: string,
  which: "privateKey" | "publicKey",
  owner: MindFileOwner | null,
): Promise<string | null> {
  const config = await readMindFile(mindDir, VOLUTE_JSON, { owner });
  let identity: VoluteConfig["identity"];
  try {
    identity = config ? (JSON.parse(config.text) as VoluteConfig).identity : undefined;
  } catch {
    return null; // unparseable: no key configured that can be read
  }
  const relPath = identity?.[which];
  if (!relPath) return null;
  return (await readMindFile(mindDir, relPath, { owner }))?.text ?? null;
}

/** Read the private key PEM from disk */
export function getPrivateKey(
  mindDir: string,
  owner: MindFileOwner | null,
): Promise<string | null> {
  return readIdentityKey(mindDir, "privateKey", owner);
}

/** Read the public key PEM from disk */
export function getPublicKey(mindDir: string, owner: MindFileOwner | null): Promise<string | null> {
  return readIdentityKey(mindDir, "publicKey", owner);
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
