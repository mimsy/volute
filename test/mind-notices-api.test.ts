import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getOrCreateMindUser } from "../packages/daemon/src/lib/auth.js";
import { drainEvents, parseMeta } from "../packages/daemon/src/lib/chat/system-events.js";
import { generateMindToken } from "../packages/daemon/src/lib/daemon/mind-tokens.js";
import { addMind, removeMind } from "../packages/daemon/src/lib/mind/registry.js";

const PORT_BASE = 4720;
let portOffset = 0;

async function makeMind(name: string): Promise<string> {
  await addMind(name, PORT_BASE + portOffset++);
  await getOrCreateMindUser(name);
  return generateMindToken(name);
}

function postHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Origin: "http://localhost",
    "Content-Type": "application/json",
  };
}

describe("POST /api/minds/:name/notices", () => {
  it("records a mind-level notice a mind can post about itself", async () => {
    const name = `notice-api-${Date.now()}-a`;
    const token = await makeMind(name);
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    try {
      const res = await app.request(`http://localhost/api/v1/minds/${name}/notices`, {
        method: "POST",
        headers: postHeaders(token),
        body: JSON.stringify({
          kind: "context_lost",
          message: "Your previous session couldn't be restored.",
        }),
      });
      assert.equal(res.status, 200);

      // No thread given → mind-level: any thread's drain picks it up.
      const drained = await drainEvents(name, "whatever-thread");
      assert.equal(drained.length, 1);
      assert.match(drained[0].body, /couldn't be restored/);
      assert.equal(parseMeta(drained[0].meta).subtype, "context_lost");
    } finally {
      await removeMind(name);
    }
  });

  it("scopes the notice to the given thread", async () => {
    const name = `notice-api-${Date.now()}-b`;
    const token = await makeMind(name);
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    try {
      const res = await app.request(`http://localhost/api/v1/minds/${name}/notices`, {
        method: "POST",
        headers: postHeaders(token),
        body: JSON.stringify({ kind: "context_lost", message: "compaction failed", thread: "dev" }),
      });
      assert.equal(res.status, 200);

      assert.equal((await drainEvents(name, "main")).length, 0, "other threads must not drain it");
      const scoped = await drainEvents(name, "dev");
      assert.equal(scoped.length, 1);
      assert.equal(scoped[0].thread, "dev");
    } finally {
      await removeMind(name);
    }
  });

  it("rejects another mind's token (403) — requireSelf boundary", async () => {
    const target = `notice-api-${Date.now()}-c`;
    const other = `notice-api-${Date.now()}-d`;
    await makeMind(target);
    const otherToken = await makeMind(other);
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    try {
      const res = await app.request(`http://localhost/api/v1/minds/${target}/notices`, {
        method: "POST",
        headers: postHeaders(otherToken),
        body: JSON.stringify({ kind: "context_lost", message: "forged" }),
      });
      assert.equal(res.status, 403);
      assert.equal((await drainEvents(target, "main")).length, 0);
    } finally {
      await removeMind(target);
      await removeMind(other);
    }
  });

  it("validates kind and message", async () => {
    const name = `notice-api-${Date.now()}-e`;
    const token = await makeMind(name);
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    try {
      for (const body of [
        { kind: "not-a-kind", message: "x" },
        // Daemon-authored kinds must not be forgeable by a mind: crash/turn_error/
        // startup drive the host "last turn failed" surface, budget becomes a budget event.
        { kind: "crash", message: "x" },
        { kind: "turn_error", message: "x" },
        { kind: "startup", message: "x" },
        { kind: "budget", message: "x" },
        { kind: "context_lost" },
        { kind: "context_lost", message: "   " },
        { kind: "context_lost", message: "x", thread: 42 },
      ]) {
        const res = await app.request(`http://localhost/api/v1/minds/${name}/notices`, {
          method: "POST",
          headers: postHeaders(token),
          body: JSON.stringify(body),
        });
        assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      }
      assert.equal((await drainEvents(name, "main")).length, 0, "no notice recorded on 400s");
    } finally {
      await removeMind(name);
    }
  });

  it("truncates an oversized message instead of dropping the notice", async () => {
    const name = `notice-api-${Date.now()}-f`;
    const token = await makeMind(name);
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    try {
      const res = await app.request(`http://localhost/api/v1/minds/${name}/notices`, {
        method: "POST",
        headers: postHeaders(token),
        body: JSON.stringify({ kind: "context_lost", message: "y".repeat(5000) }),
      });
      assert.equal(res.status, 200, "a long explanation must not be silently rejected");
      const drained = await drainEvents(name, "main");
      assert.equal(drained.length, 1);
      assert.equal(drained[0].body.length, 4001, "4000 chars plus the ellipsis");
      assert.ok(drained[0].body.endsWith("…"));
    } finally {
      await removeMind(name);
    }
  });
});
