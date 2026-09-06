import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve as resolvePath } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { composeTemplate } from "../packages/daemon/src/lib/template/template.js";

/**
 * A pi mind that rewrites its own SOUL.md/MEMORY.md/VOLUTE.md must ask for the restart
 * that puts the new system prompt into effect (#998) — pi composes the prompt once, at
 * startup, so before this the edit was silently inert.
 *
 * Driven through the composed template's real event-handler: the identity watch is fed
 * from the same tool_execution_end branch that feeds auto-commit, and drained after the
 * turn's commits flush.
 */

let composedDir: string;
let server: Server;
let createEventHandler: typeof import("../templates/pi/src/lib/event-handler.js")["createEventHandler"];
let createIdentityWatch: typeof import("../templates/_base/src/lib/identity-watch.js")["createIdentityWatch"];

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
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Run one turn that edits `path`, and report whether a reload was requested. */
async function turnEditing(
  path: string,
  opts: { willRetry?: boolean; rotated?: boolean; isError?: boolean } = {},
): Promise<boolean> {
  let reloads = 0;
  let turnEnded = false;
  const session = makeSession("main");
  const handler = createEventHandler(session as never, {
    cwd: resolvePath(composedDir, "home"),
    broadcast: () => {},
    identityWatch: createIdentityWatch(resolvePath(composedDir, "home")),
    onIdentityReload: () => {
      reloads += 1;
    },
    onTurnEnd: () => {
      turnEnded = true;
      return opts.rotated ?? false;
    },
  });

  handler({ type: "agent_start" } as never);
  handler({
    type: "tool_execution_start",
    toolCallId: "t1",
    toolName: "edit",
    args: { path },
  } as never);
  handler({
    type: "tool_execution_end",
    toolCallId: "t1",
    toolName: "edit",
    isError: opts.isError ?? false,
    result: "ok",
  } as never);
  handler({
    type: "agent_end",
    willRetry: opts.willRetry ?? false,
    messages: [{ role: "assistant" }],
  } as never);

  await waitFor(() => turnEnded);
  return reloads > 0;
}

before(async () => {
  const templatesRoot = resolvePath(fileURLToPath(import.meta.url), "../../templates");
  composedDir = composeTemplate(templatesRoot, "pi").composedDir;

  // daemon-client reads the port/mind from the environment at module load; point it at a
  // sink so the handler's event emits don't reach a real daemon.
  await new Promise<void>((r) => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    server.listen(0, "127.0.0.1", r);
  });
  process.env.VOLUTE_DAEMON_PORT = String((server.address() as { port: number }).port);
  process.env.VOLUTE_MIND = "test-mind";

  ({ createEventHandler } = await import(resolvePath(composedDir, "src/lib/event-handler.js")));
  ({ createIdentityWatch } = await import(resolvePath(composedDir, "src/lib/identity-watch.js")));
});

after(() => {
  server?.close();
  if (composedDir) rmSync(composedDir, { recursive: true, force: true });
  delete process.env.VOLUTE_DAEMON_PORT;
  delete process.env.VOLUTE_MIND;
});

describe("pi template identity reload (#998)", () => {
  it("requests a reload after a turn that edited SOUL.md", async () => {
    assert.equal(await turnEditing("SOUL.md"), true);
  });

  it("requests a reload for MEMORY.md and VOLUTE.md too", async () => {
    assert.equal(await turnEditing("MEMORY.md"), true);
    assert.equal(await turnEditing("VOLUTE.md"), true);
  });

  it("does not request a reload after a turn that edited an ordinary file", async () => {
    assert.equal(await turnEditing("memory/journal/2026-09-06.md"), false);
  });

  it("does not request a reload when the edit failed", async () => {
    assert.equal(
      await turnEditing("SOUL.md", { isError: true }),
      false,
      "a rejected edit changed nothing to reload",
    );
  });

  // A retryable agent_end keeps its queued prompts for the continuation; restarting on it
  // would kill the retry and drop the sender's message.
  it("holds the restart back on a turn that will retry", async () => {
    assert.equal(await turnEditing("SOUL.md", { willRetry: true }), false);
  });

  // Rotation rewrites the session in place at turn end; a restart on top of it discards
  // the in-memory rotation note.
  it("holds the restart back on a turn that rotated the session", async () => {
    assert.equal(await turnEditing("SOUL.md", { rotated: true }), false);
  });

  it("still asks on the next settled turn after a held-back one", async () => {
    let reloads = 0;
    let turns = 0;
    const watch = createIdentityWatch(resolvePath(composedDir, "home"));
    const session = makeSession("main");
    let rotated = true;
    const handler = createEventHandler(session as never, {
      cwd: resolvePath(composedDir, "home"),
      broadcast: () => {},
      identityWatch: watch,
      onIdentityReload: () => {
        reloads += 1;
      },
      onTurnEnd: () => {
        turns += 1;
        const wasRotated = rotated;
        rotated = false;
        return wasRotated;
      },
    });

    handler({ type: "agent_start" } as never);
    handler({
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "edit",
      args: { path: "SOUL.md" },
    } as never);
    handler({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "edit",
      isError: false,
      result: "ok",
    } as never);
    handler({ type: "agent_end", messages: [{ role: "assistant" }] } as never);
    await waitFor(() => turns === 1);
    assert.equal(reloads, 0, "held back by the rotation");

    // A later turn that touches nothing still carries the pending request.
    session.messageIds.push("m1");
    handler({ type: "agent_start" } as never);
    handler({ type: "agent_end", messages: [{ role: "assistant" }] } as never);
    await waitFor(() => turns === 2);
    assert.equal(reloads, 1, "the deferred reload fires on the next settled turn");
  });

  it("asks only once, so a restart that never lands doesn't loop every turn", async () => {
    let reloads = 0;
    let turns = 0;
    const watch = createIdentityWatch(resolvePath(composedDir, "home"));
    const session = makeSession("main");
    const handler = createEventHandler(session as never, {
      cwd: resolvePath(composedDir, "home"),
      broadcast: () => {},
      identityWatch: watch,
      onIdentityReload: () => {
        reloads += 1;
      },
      onTurnEnd: () => {
        turns += 1;
        return false;
      },
    });

    for (const id of ["t1", "t2"]) {
      session.messageIds.push("m1");
      handler({ type: "agent_start" } as never);
      handler({
        type: "tool_execution_start",
        toolCallId: id,
        toolName: "write",
        args: { path: "SOUL.md" },
      } as never);
      handler({
        type: "tool_execution_end",
        toolCallId: id,
        toolName: "write",
        isError: false,
        result: "ok",
      } as never);
      handler({ type: "agent_end", messages: [{ role: "assistant" }] } as never);
    }

    await waitFor(() => turns === 2);
    assert.equal(reloads, 1, "the reload request is latched to once per process");
  });
});
