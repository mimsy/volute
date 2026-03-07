import { createHash, verify } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { log } from "./logger.js";
import type { Router } from "./router.js";
import type { VoluteContentPart, VoluteRequest } from "./types.js";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function extractText(content: VoluteContentPart[] | string): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

/** Normalize content to VoluteContentPart[] — connectors may send plain strings. */
function normalizeContent(content: unknown): VoluteContentPart[] {
  if (Array.isArray(content)) return content as VoluteContentPart[];
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [{ type: "text", text: JSON.stringify(content) }];
}

/** Verify an Ed25519 signature against a public key */
function verifySignature(
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

/** Look up a mind's public key via the daemon API */
async function fetchPublicKey(fingerprint: string): Promise<string | null> {
  const daemonPort = process.env.VOLUTE_DAEMON_PORT;
  const daemonToken = process.env.VOLUTE_DAEMON_TOKEN;
  if (!daemonPort || !daemonToken) return null;

  try {
    const res = await fetch(
      `http://127.0.0.1:${daemonPort}/api/keys/${encodeURIComponent(fingerprint)}`,
      { headers: { Authorization: `Bearer ${daemonToken}` }, signal: AbortSignal.timeout(2000) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { publicKey?: string };
    return data.publicKey ?? null;
  } catch (err) {
    log("identity", "failed to fetch public key:", err);
    return null;
  }
}

/** Best-effort signature verification */
async function verifyRequest(body: VoluteRequest): Promise<boolean | undefined> {
  if (!body.signature || !body.signatureTimestamp || !body.signerFingerprint) return undefined;

  const publicKey = await fetchPublicKey(body.signerFingerprint);
  if (!publicKey) return false;

  // Verify the fingerprint matches
  const expectedFingerprint = createHash("sha256").update(publicKey).digest("hex");
  if (expectedFingerprint !== body.signerFingerprint) return false;

  const text = extractText(body.content);
  return verifySignature(publicKey, text, body.signatureTimestamp, body.signature);
}

export function createVoluteServer(options: {
  router: Router;
  port: number;
  name: string;
  version: string;
}): Server {
  const { router, port, name, version } = options;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", name, version }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/message") {
      try {
        const body = JSON.parse(await readBody(req)) as VoluteRequest;

        // Strip any sender-provided verified field to prevent spoofing
        delete body.verified;

        // Best-effort signature verification (non-blocking)
        const verified = await verifyRequest(body);
        if (verified !== undefined) body.verified = verified;

        // Normalize content — connectors may send plain strings
        body.content = normalizeContent(body.content);

        // Handle batch payloads from delivery manager
        if ((body as any).batch) {
          const batch = (body as any).batch as {
            channels: Record<string, any[]>;
          };
          router.dispatchBatch(batch, body.session ?? "main", body);
        } else if (body.session) {
          // Pre-routed by daemon delivery manager — dispatch directly
          router.dispatch(body.content, body.session, body);
        } else {
          // Legacy: local routing (for minds running with old daemon)
          router.route(body.content, body);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        if (err instanceof SyntaxError) {
          res.writeHead(400);
          res.end("Bad Request");
        } else {
          log("server", "error handling /message:", err);
          res.writeHead(500);
          res.end("Internal Server Error");
        }
      }
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  server.on("close", () => router.close());

  let retries = 0;
  const maxRetries = 5;
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      retries++;
      if (retries > maxRetries) {
        log("server", `port ${port} in use after ${maxRetries} retries, exiting`);
        process.exit(1);
      }
      log("server", `port ${port} in use, retrying in 1s... (${retries}/${maxRetries})`);
      setTimeout(() => server.listen(port), 1000);
    } else {
      throw err;
    }
  });

  return server;
}
