import { createHash, verify } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { log } from "./logger.js";
import type { BatchMessage, Router } from "./router.js";
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

/** Normalize content to VoluteContentPart[] — connectors may send plain strings or mixed arrays. */
function normalizeContent(content: unknown): VoluteContentPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) {
    return content.map((item): VoluteContentPart => {
      if (typeof item === "object" && item !== null && "type" in item) {
        const obj = item as Record<string, unknown>;
        if (obj.type === "image") {
          if (typeof obj.media_type === "string" && typeof obj.data === "string") {
            return { type: "image", media_type: obj.media_type, data: obj.data };
          }
          log("server", "image content part missing required fields, coercing to text");
        }
        if (typeof obj.text === "string") return { type: "text", text: obj.text };
      }
      if (typeof item !== "string") {
        log("server", `unexpected content type (${typeof item}), coercing to text`);
      }
      return { type: "text", text: typeof item === "string" ? item : JSON.stringify(item) };
    });
  }
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

export type ContextBreakdown = {
  systemPrompt: number;
  sdkInstructions: number;
  skillDescriptions: number;
  conversation: {
    userText: number;
    assistantText: number;
    thinking: number;
    toolUse: number;
    toolResult: number;
  };
};

export type SessionContextInfo = {
  name: string;
  contextTokens: number;
  contextWindow?: number;
  breakdown?: ContextBreakdown;
};

export type ContextInfo = {
  sessions: SessionContextInfo[];
  systemPrompt: number;
};

export function createVoluteServer(options: {
  router: Router;
  port: number;
  name: string;
  version: string;
  getContextInfo?: () => ContextInfo | Promise<ContextInfo>;
}): Server {
  const { router, port, name, version } = options;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", name, version }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/context") {
      if (!options.getContextInfo) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }
      try {
        const info = await options.getContextInfo();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(info));
      } catch (err) {
        log("server", "error in /context:", err);
        res.writeHead(500);
        res.end("Internal Server Error");
      }
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
        const bodyWithBatch = body as VoluteRequest & {
          batch?: { channels: Record<string, BatchMessage[]> };
        };
        if (bodyWithBatch.batch) {
          router.dispatchBatch(bodyWithBatch.batch, body.session ?? "main", body);
        } else {
          // Pre-routed by daemon delivery manager — dispatch directly
          router.dispatch(body.content, body.session ?? "main", body);
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
