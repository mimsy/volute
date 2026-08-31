import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  createUser,
  getOrCreateMindUser,
  getOrCreateSystemUser,
} from "../packages/daemon/src/lib/auth.js";
import {
  buildMindScriptEnv,
  runMindScript,
} from "../packages/daemon/src/lib/daemon/mind-script.js";
import {
  generateMindToken,
  issueScriptToken,
  resolveMindToken,
  resolveScriptToken,
  revokeMindToken,
  revokeScriptToken,
  scriptTokenExpiryForTest,
} from "../packages/daemon/src/lib/daemon/mind-tokens.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { resolveActingMind } from "../packages/daemon/src/lib/extensions.js";
import {
  addMind,
  addSpirit,
  mindDir,
  removeMind,
} from "../packages/daemon/src/lib/mind/registry.js";
import { users } from "../packages/daemon/src/lib/schema.js";
import {
  authMiddleware,
  createSession,
  invalidateMindUserCache,
  isSpiritActingOnAnother,
  requireAdmin,
  requireSelf,
  requireSelfOrSpirit,
} from "../packages/daemon/src/web/middleware/auth.js";

const SPIRIT = "volute";
const OTHER_MIND = "spirit-authority-other";
const ADMIN = "spirit-authority-admin";

const TEST_USERNAMES = [SPIRIT, OTHER_MIND, ADMIN];

async function cleanup() {
  revokeMindToken(SPIRIT);
  revokeMindToken(OTHER_MIND);
  invalidateMindUserCache(SPIRIT);
  invalidateMindUserCache(OTHER_MIND);
  const db = await getDb();
  for (const username of TEST_USERNAMES) {
    await db.delete(users).where(eq(users.username, username));
  }
  for (const mind of [SPIRIT, OTHER_MIND]) {
    try {
      await removeMind(mind);
    } catch {}
  }
}

describe("mind creation is admin-only (#433)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  function app() {
    const a = new Hono();
    a.use("/api/*", authMiddleware);
    a.post("/api/minds", requireAdmin, (c) => c.json({ ok: true }));
    return a;
  }

  it("refuses the spirit, which used to pass on the strength of being the spirit", async () => {
    // `requireAdminOrSystem` let the spirit create minds. Anyone can talk to the spirit,
    // so that made "any mind can send text" into "any mind can spawn minds" — the
    // crash-the-host vector, one conversation away from every untrusted principal.
    await addSpirit(SPIRIT, 4800);
    await getOrCreateSystemUser();
    invalidateMindUserCache(SPIRIT);
    const token = generateMindToken(SPIRIT);

    const res = await app().request("/api/minds", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
  });

  it("refuses an ordinary mind and allows an admin", async () => {
    await addMind(OTHER_MIND, 4801);
    await getOrCreateMindUser(OTHER_MIND);
    const mindToken = generateMindToken(OTHER_MIND);
    assert.equal(
      (
        await app().request("/api/minds", {
          method: "POST",
          headers: { Authorization: `Bearer ${mindToken}` },
        })
      ).status,
      403,
    );

    const admin = await createUser(ADMIN, "pass");
    const sessionId = await createSession(admin.id);
    assert.equal(
      (
        await app().request("/api/minds", {
          method: "POST",
          headers: { Cookie: `volute_session=${sessionId}` },
        })
      ).status,
      200,
    );
  });

  // The tests above exercise the middleware. This one pins the wiring: mind creation is
  // the crash-the-host vector, and which guard it carries is the whole decision.
  it("guards POST /api/minds with requireAdmin", () => {
    const src = readFileSync(
      new URL("../packages/daemon/src/web/api/minds.ts", import.meta.url),
      "utf8",
    );
    assert.match(src, /\.post\("\/", requireAdmin, zValidator\("json", createMindSchema\)/);
    assert.doesNotMatch(src, /requireAdminOrSystem/);
  });
});

describe("script tokens are scoped to their run (#433)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("hands a daemon-spawned script its own credential, not the mind's long-lived one", async () => {
    await addMind(OTHER_MIND, 4801);
    await getOrCreateMindUser(OTHER_MIND);
    const env = await buildMindScriptEnv(OTHER_MIND, mindDir(OTHER_MIND));
    const token = env.VOLUTE_MIND_TOKEN;
    assert.ok(token);
    try {
      assert.equal(resolveScriptToken(token), OTHER_MIND);
      // Distinct from the mind's own token, so revoking one never disturbs the other.
      assert.equal(resolveMindToken(token), null);
    } finally {
      revokeScriptToken(token);
    }
  });

  it("revokes the credential when the run ends", async () => {
    await addMind(OTHER_MIND, 4801);
    await getOrCreateMindUser(OTHER_MIND);
    // The mind's own token lives until the mind restarts, so a script that logged its
    // environment used to leak a credential good for the rest of the mind's uptime.
    // Scoping it to the run bounds that to seconds.
    const out = await runMindScript("bash", ["-c", 'printf "%s" "$VOLUTE_MIND_TOKEN"'], {
      mindName: OTHER_MIND,
      dir: mindDir(OTHER_MIND),
    });
    assert.ok(out.length > 0);
    assert.equal(resolveScriptToken(out), null);
  });

  it("issues a separate token per run so concurrent scripts don't revoke each other", () => {
    const a = issueScriptToken(OTHER_MIND);
    const b = issueScriptToken(OTHER_MIND);
    assert.notEqual(a, b);
    revokeScriptToken(a);
    assert.equal(resolveScriptToken(a), null);
    assert.equal(resolveScriptToken(b), OTHER_MIND);
    revokeScriptToken(b);
  });

  it("authenticates a script token as the mind, with the mind's own authority", async () => {
    await addMind(OTHER_MIND, 4801);
    await getOrCreateMindUser(OTHER_MIND);
    const token = issueScriptToken(OTHER_MIND);
    try {
      const a = new Hono();
      a.use("/api/*", authMiddleware);
      a.get("/api/who", (c) =>
        c.json({ username: c.get("user").username, role: c.get("user").role }),
      );
      const res = await a.request("/api/who", { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(res.status, 200);
      // A script is the mind acting, at the mind's own non-admin authority — the run
      // scoping tightens the credential's lifetime, it does not add power.
      assert.deepEqual(await res.json(), { username: OTHER_MIND, role: "user" });
    } finally {
      revokeScriptToken(token);
    }
  });
});

describe("the spirit's cross-mind allowlist (#433)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  async function spiritToken(): Promise<string> {
    await addSpirit(SPIRIT, 4800);
    await getOrCreateSystemUser();
    invalidateMindUserCache(SPIRIT);
    return generateMindToken(SPIRIT);
  }

  function app() {
    const a = new Hono();
    a.use("/api/*", authMiddleware);
    // Stands in for the six allowlisted routes and for everything else.
    a.post("/api/minds/:name/restart", requireSelfOrSpirit(), (c) => c.json({ ok: true }));
    a.get("/api/minds/:name/seed-check", requireSelfOrSpirit(), (c) => c.json({ ok: true }));
    a.get("/api/minds/:name/files", requireSelf(), (c) => c.json({ ok: true }));
    return a;
  }

  it("lets the spirit reach an allowlisted route on another mind", async () => {
    const token = await spiritToken();
    await addMind(OTHER_MIND, 4801);
    const res = await app().request(`/api/minds/${OTHER_MIND}/restart`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
  });

  it("refuses the spirit on a route that is not allowlisted", async () => {
    const token = await spiritToken();
    await addMind(OTHER_MIND, 4801);
    // The blanket grant was a `role === "spirit"` short-circuit inside requireSelf, so
    // every mind-scoped route silently admitted the spirit — another mind's files, env,
    // config, prompts. requireSelf has no spirit clause now; the six routes that need
    // one name requireSelfOrSpirit, and this is not one of them.
    const res = await app().request(`/api/minds/${OTHER_MIND}/files`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
  });

  it("still lets the spirit reach its own routes", async () => {
    const token = await spiritToken();
    const res = await app().request(`/api/minds/${SPIRIT}/files`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
  });

  it("does not let an ordinary mind through an allowlisted route", async () => {
    await addMind(OTHER_MIND, 4801);
    await getOrCreateMindUser(OTHER_MIND);
    await addMind("spirit-authority-third", 4802);
    const token = generateMindToken(OTHER_MIND);
    try {
      // The allowlist is the spirit's, not everyone's — requireSelfOrSpirit must still
      // be requireSelf for every other principal.
      const res = await app().request("/api/minds/spirit-authority-third/restart", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 403);
    } finally {
      try {
        await removeMind("spirit-authority-third");
      } catch {}
    }
  });
});

describe("the spirit cannot impersonate through extension commands (#433)", () => {
  it("refuses --mind for a non-admin caller, the spirit included", () => {
    // resolveActingMind gates `--mind`, which is an impersonation flag. It used to treat
    // the spirit as privileged, so `intention review-due --mind <admin>` made ctx.mindName
    // the admin's name — and a downstream `actor.role === "admin"` check then passed on
    // the *impersonated* identity. The route was fixed; this is the same escalation via
    // the dispatcher.
    const asSpirit = resolveActingMind({ username: SPIRIT, role: "spirit" }, ADMIN);
    assert.ok("error" in asSpirit);
    const asMind = resolveActingMind({ username: OTHER_MIND, role: "user" }, ADMIN);
    assert.ok("error" in asMind);
  });

  it("still lets an admin act as another mind, and everyone act as themselves", () => {
    assert.deepEqual(resolveActingMind({ username: ADMIN, role: "admin" }, OTHER_MIND), {
      mind: OTHER_MIND,
    });
    assert.deepEqual(resolveActingMind({ username: SPIRIT, role: "spirit" }, undefined), {
      mind: SPIRIT,
    });
  });
});

describe("the spirit's sleep is bounded (#433)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  const spiritUser = { role: "spirit", username: SPIRIT };

  it("recognises the spirit acting on another mind, and on itself", async () => {
    await addMind(OTHER_MIND, 4801);
    await addSpirit(SPIRIT, 4800);
    assert.equal(await isSpiritActingOnAnother(spiritUser, OTHER_MIND), true);
    // Its own sleep is unbounded, as any mind's is — the bound is on the capability it
    // holds only conditionally.
    assert.equal(await isSpiritActingOnAnother(spiritUser, SPIRIT), false);
    assert.equal(
      await isSpiritActingOnAnother({ role: "admin", username: ADMIN }, OTHER_MIND),
      false,
    );
  });

  it("keeps `sleep` from becoming `stop` by another name", () => {
    // `sleep` is on the allowlist because it returns the mind continuous, where `stop`
    // is denied. An open-ended or year-long sleep collapses that distinction and hands
    // back the withheld power through the granted route, so the route requires a wakeAt
    // within SPIRIT_MAX_SLEEP_HOURS. Pinned here because the docblock claims it.
    const src = readFileSync(
      new URL("../packages/daemon/src/web/api/minds.ts", import.meta.url),
      "utf8",
    );
    assert.match(src, /const SPIRIT_MAX_SLEEP_HOURS = 24;/);
    assert.match(src, /if \(await isSpiritActingOnAnother\(c\.get\("user"\), name\)\) \{/);
    assert.match(src, /wakeAt is required when the spirit puts another mind to sleep/);
    assert.match(src, /SPIRIT_MAX_SLEEP_MS/);
  });
});

describe("script tokens survive a long run (#433)", () => {
  it("slides its expiry on use, so a script past the TTL does not 401 mid-run", () => {
    // Scheduler.runScript passes no timeout, so a backup or export can legitimately run
    // past the TTL. A fixed expiry would be a cliff: sixty minutes of success, then 401
    // on every call — a silent partial failure the mind's old long-lived token never had.
    const token = issueScriptToken(OTHER_MIND);
    try {
      assert.equal(resolveScriptToken(token), OTHER_MIND);
      const first = scriptTokenExpiryForTest(token);
      assert.ok(first);
      // A later resolve must push the expiry out rather than counting down to it.
      const laterNow = Date.now() + 1000;
      const originalNow = Date.now;
      Date.now = () => laterNow;
      try {
        assert.equal(resolveScriptToken(token), OTHER_MIND);
      } finally {
        Date.now = originalNow;
      }
      assert.ok(scriptTokenExpiryForTest(token)! > first);
    } finally {
      revokeScriptToken(token);
    }
  });
});
