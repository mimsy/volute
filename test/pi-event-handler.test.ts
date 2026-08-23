import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve as resolvePath } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { composeTemplate } from "../packages/daemon/src/lib/template/template.js";

/**
 * Integration test for the pi template's agent_end error surfacing (#619).
 *
 * The pi template's event-handler imports sibling modules that only exist after
 * _base + pi are layered together at mind-create time, so we compose the template
 * into a temp dir and import the real composed handler. daemon-client reads the
 * daemon port/mind from the environment at module load, so we start a capture
 * server and set those env vars before the dynamic import.
 */

type Captured = {
  type: string;
  session?: string;
  content?: string;
  channel?: string;
  messageId?: string;
  metadata?: Record<string, unknown>;
};

let composedDir: string;
let server: Server;
let captured: Captured[] = [];
let createEventHandler: typeof import("../templates/pi/src/lib/event-handler.js")["createEventHandler"];

function makeSession(name: string) {
  return {
    name,
    messageIds: ["m1"] as (string | undefined)[],
    messageChannels: new Map([["m1", { channel: "#test" }]]),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out; captured=${JSON.stringify(captured)}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

before(async () => {
  const templatesRoot = resolvePath(fileURLToPath(import.meta.url), "../../templates");
  composedDir = composeTemplate(templatesRoot, "pi").composedDir;

  await new Promise<void>((r) => {
    server = createServer((req, res) => {
      if (req.method === "POST" && req.url?.endsWith("/events")) {
        let body = "";
        req.on("data", (c) => {
          body += c;
        });
        req.on("end", () => {
          try {
            captured.push(JSON.parse(body));
          } catch {
            // ignore malformed
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, "127.0.0.1", r);
  });

  const port = (server.address() as { port: number }).port;
  process.env.VOLUTE_DAEMON_PORT = String(port);
  process.env.VOLUTE_MIND = "test-mind";

  ({ createEventHandler } = await import(resolvePath(composedDir, "src/lib/event-handler.js")));
});

after(() => {
  server?.close();
  if (composedDir) rmSync(composedDir, { recursive: true, force: true });
  delete process.env.VOLUTE_DAEMON_PORT;
  delete process.env.VOLUTE_MIND;
});

describe("pi template event-handler agent_end errors", () => {
  it("emits an error event to the daemon when agent_end reports an errorMessage", async () => {
    captured = [];
    const session = makeSession("main");
    const handler = createEventHandler(session as never, {
      cwd: resolvePath(composedDir, "home"),
      broadcast: () => {},
    });

    handler({ type: "agent_start" } as never);
    handler({
      type: "agent_end",
      messages: [{ role: "assistant", errorMessage: '401 {"message":"User not found."}' }],
    } as never);

    await waitFor(
      () => captured.some((e) => e.type === "error") && captured.some((e) => e.type === "done"),
    );

    const errors = captured.filter((e) => e.type === "error");
    assert.equal(errors.length, 1, "exactly one error event");
    assert.equal(errors[0].session, "main");
    assert.match(errors[0].content ?? "", /401/);

    // The daemon relies on error-before-done ordering: error flags the session so the
    // following done doesn't clear the turn_error notice.
    const errorIdx = captured.findIndex((e) => e.type === "error");
    const doneIdx = captured.findIndex((e) => e.type === "done");
    assert.ok(errorIdx < doneIdx, "error is emitted before done");
  });

  it("dedupes identical error messages within one turn", async () => {
    captured = [];
    const session = makeSession("main");
    const handler = createEventHandler(session as never, {
      cwd: resolvePath(composedDir, "home"),
      broadcast: () => {},
    });

    handler({ type: "agent_start" } as never);
    handler({
      type: "agent_end",
      messages: [
        { role: "assistant", errorMessage: "boom" },
        { role: "assistant", errorMessage: "boom" },
      ],
    } as never);

    await waitFor(() => captured.some((e) => e.type === "done"));
    const errors = captured.filter((e) => e.type === "error");
    assert.equal(errors.length, 1, "identical errors collapse to a single notice");
  });

  it("emits distinct error events for distinct error messages", async () => {
    captured = [];
    const session = makeSession("main");
    const handler = createEventHandler(session as never, {
      cwd: resolvePath(composedDir, "home"),
      broadcast: () => {},
    });

    handler({ type: "agent_start" } as never);
    handler({
      type: "agent_end",
      messages: [
        { role: "assistant", errorMessage: "first failure" },
        { role: "assistant", errorMessage: "second failure" },
      ],
    } as never);

    await waitFor(() => captured.some((e) => e.type === "done"));
    const errors = captured.filter((e) => e.type === "error").map((e) => e.content);
    assert.deepEqual(errors.sort(), ["first failure", "second failure"]);
  });

  it("emits no error event on a clean agent_end", async () => {
    captured = [];
    const session = makeSession("main");
    const handler = createEventHandler(session as never, {
      cwd: resolvePath(composedDir, "home"),
      broadcast: () => {},
    });

    handler({ type: "agent_start" } as never);
    handler({
      type: "agent_end",
      messages: [{ role: "assistant" }],
    } as never);

    await waitFor(() => captured.some((e) => e.type === "done"));
    assert.equal(captured.filter((e) => e.type === "error").length, 0);
  });

  // The error loop intentionally has no role gate (unlike the usage-summing loop):
  // a provider error can arrive on a non-assistant message and must still surface.
  // This pins that behavior so a later "consistency" refactor adding a role check fails.
  it("surfaces an error regardless of message role", async () => {
    captured = [];
    const session = makeSession("main");
    const handler = createEventHandler(session as never, {
      cwd: resolvePath(composedDir, "home"),
      broadcast: () => {},
    });

    handler({ type: "agent_start" } as never);
    handler({
      type: "agent_end",
      messages: [{ errorMessage: "provider exploded" }],
    } as never);

    await waitFor(() => captured.some((e) => e.type === "done"));
    const errors = captured.filter((e) => e.type === "error");
    assert.equal(errors.length, 1, "error surfaces even without role: assistant");
    assert.equal(errors[0].content, "provider exploded");
  });

  it("still reports token usage on an errored turn", async () => {
    captured = [];
    const session = makeSession("main");
    const handler = createEventHandler(session as never, {
      cwd: resolvePath(composedDir, "home"),
      broadcast: () => {},
    });

    handler({ type: "agent_start" } as never);
    handler({
      type: "agent_end",
      messages: [{ role: "assistant", errorMessage: "boom", usage: { input: 100, output: 20 } }],
    } as never);

    await waitFor(() => captured.some((e) => e.type === "done"));
    assert.equal(captured.filter((e) => e.type === "error").length, 1, "error still emitted");
    const usage = captured.find((e) => e.type === "usage");
    assert.equal(usage?.metadata?.input_tokens, 100, "usage still reported alongside the error");
    assert.equal(usage?.metadata?.output_tokens, 20);
  });
});

describe("pi template event-handler usage", () => {
  it("sums cache reads/writes across assistant messages and names the model", async () => {
    captured = [];
    const session = makeSession("main");
    const handler = createEventHandler(session as never, {
      cwd: resolvePath(composedDir, "home"),
      broadcast: () => {},
    });

    handler({ type: "agent_start" } as never);
    handler({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          provider: "anthropic",
          model: "claude-haiku-4-5",
          usage: { input: 500, output: 40, cacheRead: 20_000, cacheWrite: 1_500 },
        },
        {
          role: "assistant",
          provider: "anthropic",
          model: "claude-haiku-4-5",
          usage: { input: 300, output: 60, cacheRead: 21_500, cacheWrite: 0 },
        },
      ],
    } as never);

    await waitFor(() => captured.some((e) => e.type === "usage"));
    const usage = captured.find((e) => e.type === "usage")?.metadata;
    assert.deepEqual(usage, {
      input_tokens: 800,
      output_tokens: 100,
      cache_read_input_tokens: 41_500,
      cache_creation_input_tokens: 1_500,
      model: "anthropic:claude-haiku-4-5",
    });
  });

  it("emits usage for a turn that was served entirely from cache", async () => {
    captured = [];
    const session = makeSession("main");
    const handler = createEventHandler(session as never, {
      cwd: resolvePath(composedDir, "home"),
      broadcast: () => {},
    });

    handler({ type: "agent_start" } as never);
    handler({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          provider: "openrouter",
          model: "moonshotai/kimi-k2.5",
          usage: { input: 0, output: 0, cacheRead: 30_000, cacheWrite: 0 },
        },
      ],
    } as never);

    await waitFor(() => captured.some((e) => e.type === "usage"));
    const usage = captured.find((e) => e.type === "usage")?.metadata;
    assert.equal(usage?.cache_read_input_tokens, 30_000);
    assert.equal(usage?.model, "openrouter:moonshotai/kimi-k2.5");
  });
});
