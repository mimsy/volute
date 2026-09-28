import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { log } from "./logger.js";

/** A subagent the mind can call, as a tool of the same name. */
export type SubagentTool = { name: string; description: string };

/** What running a subagent returned: its final text, or why it failed. */
export type SubagentOutcome = { text: string; isError?: boolean };

/** Runs one subagent for the thread that called it. */
export type RunSubagent = (
  session: string,
  name: string,
  prompt: string,
) => Promise<SubagentOutcome>;

export type SubagentServer = {
  /** The MCP endpoint for one thread: calls through it run on that thread's behalf. */
  url: (session: string) => string;
  /** The env var codex reads the bearer token from (`bearer_token_env_var`). */
  tokenEnvVar: string;
};

export const SUBAGENT_TOKEN_ENV = "VOLUTE_SUBAGENT_TOKEN";

/** The MCP protocol revision answered when a client asks for one we don't recognise. */
const PROTOCOL_VERSION = "2025-06-18";

type JsonRpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };

/**
 * A minimal MCP server over streamable HTTP, on 127.0.0.1, that offers each of the mind's
 * configured subagents to codex as a tool (#1200). codex has no subagent API of its own
 * that a mind can shape — its native `spawn_agent` spawns copies with every tool and the
 * whole prompt — so a subagent here is a nested codex thread the mind server runs itself,
 * which is also what lets its usage be counted against the mind's spend cap.
 *
 * The protocol surface is the small part codex needs: `initialize`, `tools/list`,
 * `tools/call`, `ping`, and notifications (acknowledged, ignored). Each POST gets one JSON
 * response; there is no server-initiated stream (GET answers 405, which the spec allows).
 *
 * It listens on loopback with a random bearer token, handed to `codex exec` through the
 * environment (never argv — `--config` values are visible in `ps`): anything else on the
 * host that reached this port could otherwise run the mind's subagents on its bill.
 */
export async function startSubagentServer(
  tools: SubagentTool[],
  run: RunSubagent,
): Promise<SubagentServer> {
  const token = randomBytes(24).toString("hex");
  process.env[SUBAGENT_TOKEN_ENV] = token;
  const expected = Buffer.from(`Bearer ${token}`);

  const authorized = (req: IncomingMessage) => {
    const got = Buffer.from(req.headers.authorization ?? "");
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  const handle = async (session: string, msg: JsonRpcRequest): Promise<object | null> => {
    const reply = (result: object) => ({ jsonrpc: "2.0", id: msg.id, result });
    const fail = (code: number, message: string) => ({
      jsonrpc: "2.0",
      id: msg.id ?? null,
      error: { code, message },
    });
    // A notification (no id) gets no response.
    if (msg.id === undefined || msg.id === null) return null;
    switch (msg.method) {
      case "initialize":
        return reply({
          protocolVersion:
            typeof msg.params?.protocolVersion === "string"
              ? msg.params.protocolVersion
              : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "volute-subagents", version: "1.0.0" },
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: {
              type: "object",
              properties: {
                prompt: { type: "string", description: `What to ask the ${t.name} subagent` },
              },
              required: ["prompt"],
            },
          })),
        });
      case "tools/call": {
        const name = msg.params?.name;
        const prompt = msg.params?.arguments?.prompt;
        if (!tools.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
        if (typeof prompt !== "string" || !prompt) {
          return reply({
            content: [{ type: "text", text: "A subagent needs a `prompt`." }],
            isError: true,
          });
        }
        const outcome = await run(session, name, prompt);
        return reply({
          content: [{ type: "text", text: outcome.text }],
          ...(outcome.isError ? { isError: true } : {}),
        });
      }
      default:
        return fail(-32601, `Method not found: ${msg.method}`);
    }
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const match = /^\/mcp\/([^/?]+)$/.exec(req.url ?? "");
    if (!match) {
      res.writeHead(404).end();
      return;
    }
    if (!authorized(req)) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    let session: string;
    try {
      session = decodeURIComponent(match[1]);
    } catch {
      res.writeHead(400).end();
      return;
    }
    let raw = "";
    req.on("data", (d) => {
      raw += d;
    });
    req.on("end", async () => {
      let body: JsonRpcRequest | JsonRpcRequest[];
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          }),
        );
        return;
      }
      try {
        const replies = (
          await Promise.all((Array.isArray(body) ? body : [body]).map((m) => handle(session, m)))
        ).filter((r) => r !== null);
        if (replies.length === 0) {
          res.writeHead(202).end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
      } catch (err) {
        log("mind", "subagent server: request failed:", err);
        if (!res.headersSent) res.writeHead(500).end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  log(
    "mind",
    `subagents offered over MCP on 127.0.0.1:${port}: ${tools.map((t) => t.name).join(", ")}`,
  );

  return {
    url: (session) => `http://127.0.0.1:${port}/mcp/${encodeURIComponent(session)}`,
    tokenEnvVar: SUBAGENT_TOKEN_ENV,
  };
}
