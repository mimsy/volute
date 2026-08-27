import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { createUser } from "../packages/daemon/src/lib/auth.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { users } from "../packages/daemon/src/lib/schema.js";
import { createSession, deleteSession } from "../packages/daemon/src/web/middleware/auth.js";

const USERNAME = "oauth-flow-admin";

let cookie: string;

async function cleanup() {
  const db = await getDb();
  await db.delete(users).where(eq(users.username, USERNAME));
}

describe("POST /ai/oauth/code/:flowId", () => {
  const realFetch = globalThis.fetch;

  before(async () => {
    await cleanup();
    const user = await createUser(USERNAME, "pass");
    cookie = await createSession(user.id);
  });

  after(async () => {
    globalThis.fetch = realFetch;
    if (cookie) await deleteSession(cookie);
    await cleanup();
  });

  it("refuses a pasted code for a flow that never asked for one", async () => {
    // Regression. The guard here used to be `if (!flow.resolveCode)`, which made sense
    // when pi-ai told us up front (via `usesCallbackServer`) whether a flow would ask
    // for a pasted code, so the resolver was only armed for flows that would. pi-ai
    // 0.84 dropped that signal, so the resolver is now armed for *every* flow and the
    // old guard could never fire. A code pasted into a device-code flow (xAI, GitHub
    // Copilot) then resolved a promise nothing awaits and answered `{ok: true}` —
    // telling the admin their code was accepted when nothing whatsoever happened.
    //
    // xAI is a device-code flow: it announces a code to type at auth.x.ai and never
    // prompts. Hanging its device-code request keeps the flow pending and unprompted,
    // which is exactly the state a confused admin would paste into.
    globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;

    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const headers = {
      Cookie: `volute_session=${cookie}`,
      Origin: "http://localhost",
      "Content-Type": "application/json",
    };

    const started = await app.request("/api/v1/system/ai/oauth/start", {
      method: "POST",
      headers,
      body: JSON.stringify({ provider: "xai" }),
    });
    assert.equal(started.status, 200);
    const { flowId, needsManualCode } = (await started.json()) as {
      flowId: string;
      needsManualCode: boolean;
    };
    assert.ok(flowId, "a flow should have been started");
    assert.equal(needsManualCode, false, "a device-code flow must not ask for a pasted code");

    const pasted = await app.request(`/api/v1/system/ai/oauth/code/${flowId}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ code: "not-a-code-this-flow-wants" }),
    });
    assert.equal(pasted.status, 400, "pasting into an unprompted flow must be refused");
    const body = (await pasted.json()) as { error?: string };
    assert.match(body.error ?? "", /does not accept manual code/);
  });

  it("404s for a flow id that does not exist", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request("/api/v1/system/ai/oauth/code/no-such-flow", {
      method: "POST",
      headers: {
        Cookie: `volute_session=${cookie}`,
        Origin: "http://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: "whatever" }),
    });
    assert.equal(res.status, 404);
  });
});
