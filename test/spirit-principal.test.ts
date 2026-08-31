import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  approveUser,
  createUser,
  getOrCreateMindUser,
  getOrCreateSystemUser,
  type User,
} from "../packages/daemon/src/lib/auth.js";
import { eventChannel } from "../packages/daemon/src/lib/chat/system-events.js";
import { buildMindScriptEnv } from "../packages/daemon/src/lib/daemon/mind-script.js";
import {
  generateMindToken,
  revokeMindToken,
  revokeScriptToken,
} from "../packages/daemon/src/lib/daemon/mind-tokens.js";
import {
  assignSession,
  clearMind,
  createTurn,
} from "../packages/daemon/src/lib/daemon/turn-tracker.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  addMind,
  addSpirit,
  mindDir,
  removeMind,
} from "../packages/daemon/src/lib/mind/registry.js";
import { mindHistory, turns, users } from "../packages/daemon/src/lib/schema.js";
import { slugify } from "../packages/daemon/src/lib/util/slugify.js";
import {
  authMiddleware,
  createSession,
  invalidateMindUserCache,
  type Principal,
  requireAdmin,
  requireSelf,
  requireSelfOrSpirit,
  resolvePrincipal,
} from "../packages/daemon/src/web/middleware/auth.js";
import {
  _selfInitiatedEventKinds,
  resolveEffective,
} from "../packages/daemon/src/web/middleware/effective-principal.js";

const SPIRIT = "volute";
const OTHER_MIND = "spirit-principal-other";
const ASKING_MIND = "spirit-principal-asker";
const ADMIN = "spirit-principal-admin";
const PLAIN = "spirit-principal-plain";
const PENDING = "spirit-principal-pending";
const PUPPET = "discord:99999";
const PUPPET_SLUG_TWIN = "discord-99999";

const TEST_USERNAMES = [
  SPIRIT,
  OTHER_MIND,
  ASKING_MIND,
  ADMIN,
  PLAIN,
  PENDING,
  PUPPET,
  PUPPET_SLUG_TWIN,
];

async function cleanup() {
  await clearMind(SPIRIT);
  revokeMindToken(SPIRIT);
  revokeMindToken(OTHER_MIND);
  invalidateMindUserCache(SPIRIT);
  invalidateMindUserCache(OTHER_MIND);
  const db = await getDb();
  await db.delete(mindHistory).where(eq(mindHistory.mind, SPIRIT));
  await db.delete(turns).where(eq(turns.mind, SPIRIT));
  for (const username of TEST_USERNAMES) {
    await db.delete(users).where(eq(users.username, username));
  }
  for (const mind of [SPIRIT, OTHER_MIND, ASKING_MIND]) {
    try {
      await removeMind(mind);
    } catch {}
  }
}

/** The spirit reuses the shared system user, so this is the account under test. */
async function spiritUser(): Promise<User> {
  await addSpirit(SPIRIT, 4700);
  return getOrCreateSystemUser();
}

/**
 * Open a daemon-tracked turn for the spirit on `session` and attribute rows to it,
 * the way the delivery path and turn lifecycle would. `rows` is what the daemon
 * recorded — that, not the session slug, is where authority comes from.
 */
type TurnRow =
  | { type: "inbound"; sender: string | null }
  /** `kind` becomes the row's `event:<kind>:<id>` channel, as eventChannel() writes it. */
  | { type: "event"; kind: string };

/**
 * The spirit's routes.json keys sessions by channel, so session and channel coincide for
 * it — which is why these fixtures pass the DM slug as the session. Inbound rows carry
 * the slug `buildVoluteSlug` derived from the conversation's participants.
 */
async function openTurn(session: string, rows: TurnRow[]): Promise<string> {
  const turnId = await createTurn(SPIRIT);
  assert.ok(turnId);
  await assignSession(SPIRIT, turnId, session);
  const db = await getDb();
  let eventId = 0;
  for (const row of rows) {
    await db.insert(mindHistory).values({
      mind: SPIRIT,
      type: row.type,
      channel: row.type === "event" ? eventChannel(row.kind, ++eventId) : session,
      sender: row.type === "inbound" ? row.sender : null,
      turn_id: turnId,
      content: "x",
    });
  }
  return turnId;
}

describe("spirit effective principal (#433 / #1017)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("leaves every non-spirit principal at its own role and its own scope", async () => {
    await addMind(OTHER_MIND, 4701);
    const mindUser = await getOrCreateMindUser(OTHER_MIND);
    assert.deepEqual(await resolveEffective({ user: mindUser }), {
      role: "user",
      scopes: [OTHER_MIND],
    });

    const admin = await createUser(ADMIN, "pass");
    assert.deepEqual(await resolveEffective({ user: admin }), {
      role: "admin",
      scopes: [ADMIN],
    });
  });

  it("drops the spirit to basic when no daemon-tracked turn backs its claim", async () => {
    const spirit = await spiritUser();
    // The header is self-reported process env. Claiming a session is not evidence:
    // with no active turn there is nothing to resolve a principal from.
    assert.deepEqual(await resolveEffective({ user: spirit, mindSession: `@${ADMIN}` }), {
      role: "basic",
      scopes: [SPIRIT],
    });
    assert.deepEqual(await resolveEffective({ user: spirit }), {
      role: "basic",
      scopes: [SPIRIT],
    });
  });

  it("borrows an admin's authority when an admin triggered the turn", async () => {
    const spirit = await spiritUser();
    const admin = await createUser(ADMIN, "pass");
    await openTurn(`@${ADMIN}`, [{ type: "inbound", sender: admin.username }]);

    const effective = await resolveEffective({ user: spirit, mindSession: `@${ADMIN}` });
    assert.equal(effective.role, "admin");
    assert.equal(effective.actingFor, ADMIN);
    // Delegation adds a scope rather than replacing one: the spirit still has to
    // post its own events and read its own history during someone else's turn.
    assert.deepEqual(effective.scopes.slice().sort(), [ADMIN, SPIRIT].sort());
  });

  it("caps the spirit at the requester's own authority when a mind triggered the turn", async () => {
    const spirit = await spiritUser();
    await addMind(ASKING_MIND, 4702);
    await getOrCreateMindUser(ASKING_MIND);
    await openTurn(`@${ASKING_MIND}`, [{ type: "inbound", sender: ASKING_MIND }]);

    const effective = await resolveEffective({ user: spirit, mindSession: `@${ASKING_MIND}` });
    assert.equal(effective.role, "user");
    assert.equal(effective.actingFor, ASKING_MIND);
  });

  it("ignores the claimed slug and resolves from the turn the daemon recorded", async () => {
    const spirit = await spiritUser();
    await createUser(ADMIN, "pass");
    await addMind(ASKING_MIND, 4702);
    await getOrCreateMindUser(ASKING_MIND);
    // The only active turn was triggered by a plain mind. An injected spirit claiming
    // the admin's session cannot conjure a turn that does not exist.
    await openTurn(`@${ASKING_MIND}`, [{ type: "inbound", sender: ASKING_MIND }]);

    assert.equal(
      (await resolveEffective({ user: spirit, mindSession: `@${ADMIN}` })).role,
      "basic",
    );
  });

  it("drops to basic when a turn carries more than one distinct sender", async () => {
    const spirit = await spiritUser();
    const admin = await createUser(ADMIN, "pass");
    await addMind(ASKING_MIND, 4702);
    await getOrCreateMindUser(ASKING_MIND);
    // linkInboundToActiveTurn folds mid-turn arrivals into the running turn, so a
    // non-admin can speak into an admin's turn. Neither authority survives that.
    await openTurn(`@${ADMIN}`, [
      { type: "inbound", sender: admin.username },
      { type: "inbound", sender: ASKING_MIND },
    ]);

    assert.equal(
      (await resolveEffective({ user: spirit, mindSession: `@${ADMIN}` })).role,
      "basic",
    );
  });

  it("treats an event-only turn as the spirit's own self-initiated work", async () => {
    const spirit = await spiritUser();
    // A schedule fire arrives as a system event with a null sender — nobody asked.
    await openTurn("main", [{ type: "event", kind: "schedule" }]);

    assert.deepEqual(await resolveEffective({ user: spirit, mindSession: "main" }), {
      role: "system",
      scopes: [SPIRIT],
    });
  });

  it("refuses to call a turn self-initiated when the spirit could have raised the event", async () => {
    const spirit = await spiritUser();
    // POST /:name/webhook/:event is requireSelf(), so a spirit at basic passes it on
    // itself, and it writes a null-sender event row exactly like a schedule fire. If
    // that counted as self-initiated, basic would be one request away from system —
    // with the attacker's own body as the turn's content.
    await openTurn("main", [{ type: "event", kind: "webhook" }]);
    assert.equal((await resolveEffective({ user: spirit, mindSession: "main" })).role, "basic");

    // Nor may a principal-requestable event ride along beside a daemon-raised one.
    await clearMind(SPIRIT);
    await openTurn("main", [
      { type: "event", kind: "schedule" },
      { type: "event", kind: "webhook" },
    ]);
    assert.equal((await resolveEffective({ user: spirit, mindSession: "main" })).role, "basic");
  });

  it("admits only `schedule` to the self-initiated allowlist", () => {
    // The allowlist is the security boundary, and every one of these was in it at some
    // point during review. `channel` fires whenever anyone messages an unrouted channel
    // and carries their name and text; `lifecycle` carries a sprouting seed's display
    // name; `webhook` is a requireSelf() route whose whole body is the caller's. Each
    // is a way to hand the spirit admin-equivalent authority on demand.
    assert.deepEqual([..._selfInitiatedEventKinds], ["schedule"]);
  });

  it("refuses the self-initiated tier for events any principal can provoke", async () => {
    const spirit = await spiritUser();
    for (const kind of ["webhook", "channel", "lifecycle", "notice", "wake"]) {
      await clearMind(SPIRIT);
      await openTurn("main", [{ type: "event", kind }]);
      assert.equal(
        (await resolveEffective({ user: spirit, mindSession: "main" })).role,
        "basic",
        `event kind "${kind}" must not confer the self-initiated tier`,
      );
    }
  });

  // The resolver's evidence is event rows the daemon wrote. That only holds because a
  // mind cannot write them itself: POST /:name/events is requireSelf(), so the spirit
  // passes it at `basic`, and the sole thing stopping it from POSTing a synthetic
  // `event` row on an `event:schedule:N` channel — forging its own self-initiated turn
  // outright — is minds.ts's DAEMON_AUTHORED_TYPES guard. Relaxing that guard silently
  // dismantles this whole mechanism, so pin the coupling here where the reason is
  // written down rather than leaving it implied two files away.
  it("depends on minds.ts refusing mind-authored `event` and `inbound` rows", () => {
    const src = readFileSync(
      new URL("../packages/daemon/src/web/api/minds.ts", import.meta.url),
      "utf8",
    );
    assert.match(src, /DAEMON_AUTHORED_TYPES = new Set\(\["inbound", "event"\]\)/);
    assert.match(src, /if \(DAEMON_AUTHORED_TYPES\.has\(body\.type\)\) \{/);
  });

  it("refuses a claimed session the turn's own recorded thread does not match", async () => {
    const spirit = await spiritUser();
    // getActiveTurnId falls back to the sessionless `mind:*` slot, so without a check
    // against the thread the daemon recorded, any slug at all resolves to whatever turn
    // is mid-creation.
    const turnId = await createTurn(SPIRIT);
    assert.ok(turnId);
    const db = await getDb();
    await db.insert(mindHistory).values({
      mind: SPIRIT,
      type: "event",
      channel: eventChannel("schedule", 1),
      turn_id: turnId,
      content: "x",
    });
    assert.equal(
      (await resolveEffective({ user: spirit, mindSession: "@anything-at-all" })).role,
      "basic",
    );
    // And absence of a slug must not match a thread the daemon has not recorded yet.
    assert.equal((await resolveEffective({ user: spirit })).role, "basic");
  });

  it("refuses to call an unattributed turn self-initiated", async () => {
    const spirit = await spiritUser();
    // linkPendingInbound is warn-and-continue, so a user-triggered turn can end up
    // with nothing linked to it. Reading "no inbound rows" as "self-initiated" would
    // turn a failed DB write into an escalation, so system needs positive evidence.
    const turnId = await createTurn(SPIRIT);
    assert.ok(turnId);
    await assignSession(SPIRIT, turnId, "main");

    assert.equal((await resolveEffective({ user: spirit, mindSession: "main" })).role, "basic");
  });

  it("drops to basic when a turn's inbound has no recorded sender", async () => {
    const spirit = await spiritUser();
    await openTurn("#commons", [{ type: "inbound", sender: null }]);

    assert.equal((await resolveEffective({ user: spirit, mindSession: "#commons" })).role, "basic");
  });

  it("drops to basic for an unknown or unapproved requester", async () => {
    const spirit = await spiritUser();
    await openTurn("@ghost", [{ type: "inbound", sender: "no-such-user" }]);
    assert.equal((await resolveEffective({ user: spirit, mindSession: "@ghost" })).role, "basic");

    await clearMind(SPIRIT);
    await createUser(ADMIN, "pass"); // first human auto-admins, so this one takes it
    const pending = await createUser(PENDING, "pass");
    assert.equal(pending.role, "pending");
    await openTurn(`@${PENDING}`, [{ type: "inbound", sender: PENDING }]);
    assert.equal(
      (await resolveEffective({ user: spirit, mindSession: `@${PENDING}` })).role,
      "basic",
    );
  });

  it("refuses a sender the channel's own participant slug contradicts", async () => {
    const spirit = await spiritUser();
    await createUser(ADMIN, "pass");
    // The shape of the bridge attack: someone renames themselves on Discord and DMs the
    // bridged spirit. The delivery path writes their display name into `sender`, but the
    // channel slug is built from the conversation participants — the puppet they really
    // are. The two disagree, so no authority is lent.
    await openTurn("@discord-12345", [{ type: "inbound", sender: ADMIN }]);
    assert.equal(
      (await resolveEffective({ user: spirit, mindSession: "@discord-12345" })).role,
      "basic",
    );
  });

  it("refuses to lend authority to a puppet, however well-namespaced", async () => {
    const spirit = await spiritUser();
    const db = await getDb();
    // A puppet is an external identity Volute never authenticated. With #1019's
    // namespacing the slug matches perfectly — `discord:99999` slugifies to its own DM
    // slug `discord-99999`, since slugify maps `:` to `-` — so the DM-only and
    // slug-agreement conditions both pass and only this one refuses it. That is what
    // makes it an independent containment, not a belt over the other two.
    assert.equal(slugify(PUPPET), PUPPET_SLUG_TWIN);
    await db.insert(users).values({
      username: PUPPET,
      password_hash: "!puppet",
      role: "user",
      user_type: "puppet",
    });
    await openTurn(`@${PUPPET_SLUG_TWIN}`, [{ type: "inbound", sender: PUPPET }]);
    assert.equal(
      (await resolveEffective({ user: spirit, mindSession: `@${PUPPET_SLUG_TWIN}` })).role,
      "basic",
    );
  });

  // #1019's namespacing made puppet usernames carry `:`, and slugify folds `:` to `-`,
  // so a puppet (`discord:99999`) and a registrable human name (`discord-99999`) collide
  // on one slug. The resolver must resolve the *sender string* the daemon recorded —
  // which names the puppet — and never reach the human who happens to own the slug.
  it("does not let a puppet's slug collision reach the human who owns the slug", async () => {
    const spirit = await spiritUser();
    const db = await getDb();
    const twin = await createUser(PUPPET_SLUG_TWIN, "pass"); // first human → admin
    assert.equal(twin.role, "admin");
    await db.insert(users).values({
      username: PUPPET,
      password_hash: "!puppet",
      role: "user",
      user_type: "puppet",
    });
    // The puppet's DM: channel slug derived from its username collides with the
    // admin's, but the recorded sender is the namespaced puppet, and that is what
    // resolution follows.
    await openTurn(`@${PUPPET_SLUG_TWIN}`, [{ type: "inbound", sender: PUPPET }]);
    assert.equal(
      (await resolveEffective({ user: spirit, mindSession: `@${PUPPET_SLUG_TWIN}` })).role,
      "basic",
    );
  });

  it("refuses delegation from a channel, where no slug names the counterpart", async () => {
    const spirit = await spiritUser();
    const admin = await createUser(ADMIN, "pass");
    // Design point 2 of the issue: `#channel` sessions are least privilege. A channel
    // slug names the room, not the speaker, so there is nothing to check the sender
    // string against — and a room is the wrong place to hand out admin anyway.
    //
    // The room is named after the admin on purpose. Any channel would show the rule, but
    // only this one shows the rule is *needed*: without the DM check the slug comparison
    // passes, because `#james` and `@james` differ by one character the sender comparison
    // never sees. Anyone who can name a channel could otherwise mint a room that lends
    // its namesake's authority to whoever speaks in it.
    await openTurn(`#${ADMIN}`, [{ type: "inbound", sender: admin.username }]);
    assert.equal(
      (await resolveEffective({ user: spirit, mindSession: `#${ADMIN}` })).role,
      "basic",
    );
  });

  it("refuses to let the spirit borrow its own authority", async () => {
    const spirit = await spiritUser();
    // Otherwise the spirit talking to itself restores the standing superuser.
    await openTurn("main", [{ type: "inbound", sender: SPIRIT }]);

    assert.equal((await resolveEffective({ user: spirit, mindSession: "main" })).role, "basic");
  });

  // Wiring pins. Middleware tests exercise the guards directly and cannot see a call
  // site being re-loosened — the exact blindness that let a deleted rule stay green
  // during this design's first review — so the load-bearing call sites are pinned as
  // source. Each is a security decision, not a refactor target.
  it("gates extension --mind impersonation on admin authority, never the system tier", () => {
    // The `system` tier is self-reachable (the spirit configures its own schedules),
    // so gating impersonation on hasSystemAuthority would let a self-added schedule
    // act as any mind and sail through downstream ownership checks on the
    // impersonated identity (#907's escalation, reopened). review-due — the one
    // privileged system-tier command — never names a foreign --mind.
    const src = readFileSync(
      new URL("../packages/daemon/src/lib/extensions.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      src,
      /resolveActingMind\(user, body\.mind, hasAdminAuthority\(c\.get\("effective"\)\)\)/,
    );
  });

  it("keeps borrowed authority off the streams, where it would outlive its turn", () => {
    // A stream captures authority once at connect. Borrowed (actingFor) admin
    // authority is scoped to a turn, so a stream opened during that turn would keep
    // the global firehose after it ended — delegation covers discrete requests only.
    const events = readFileSync(
      new URL("../packages/daemon/src/web/api/v1/events.ts", import.meta.url),
      "utf8",
    );
    assert.match(events, /hasAdminAuthority\(effective\) && !effective\?\.actingFor/);
    const system = readFileSync(
      new URL("../packages/daemon/src/web/api/system.ts", import.meta.url),
      "utf8",
    );
    assert.match(system, /!hasAdminAuthority\(effective\) \|\| effective\?\.actingFor/);
  });
});

describe("script tokens resolve the self-initiated tier (#433 / #1017)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("gives a spirit script the self-initiated tier without a turn to point at", async () => {
    const spirit = await spiritUser();
    // A scheduled script (`volute seed check`) has no turn of its own. The token the
    // daemon minted for a process the daemon spawned is the evidence a session slug
    // could never be.
    assert.deepEqual(await resolveEffective({ user: spirit, viaScript: true }), {
      role: "system",
      scopes: [SPIRIT],
    });
    // A stale session file riding along on the script changes nothing.
    assert.deepEqual(
      await resolveEffective({ user: spirit, mindSession: "@someone", viaScript: true }),
      { role: "system", scopes: [SPIRIT] },
    );
  });

  it("leaves an ordinary mind's script at exactly the mind's own authority", async () => {
    await addMind(OTHER_MIND, 4701);
    const mindUser = await getOrCreateMindUser(OTHER_MIND);
    assert.deepEqual(await resolveEffective({ user: mindUser, viaScript: true }), {
      role: "user",
      scopes: [OTHER_MIND],
    });
  });

  it("hands a daemon-spawned script a live script credential, and flags it as one", async () => {
    await addMind(OTHER_MIND, 4701);
    await getOrCreateMindUser(OTHER_MIND);
    // The end-to-end wiring: what buildMindScriptEnv puts in the child's env must be
    // a credential resolvePrincipal recognises as script-issued, or the tier this
    // whole mechanism exists to preserve silently stops being reachable.
    const env = await buildMindScriptEnv(OTHER_MIND, mindDir(OTHER_MIND));
    const token = env.VOLUTE_MIND_TOKEN;
    assert.ok(token);
    try {
      const app = new Hono();
      let seen: Principal | null = null;
      app.get("/probe", async (c) => {
        seen = await resolvePrincipal(c);
        return c.json({ ok: true });
      });
      await app.request("/probe", { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(seen?.user.username, OTHER_MIND);
      assert.equal(seen?.viaScript, true);
    } finally {
      revokeScriptToken(token);
    }
  });

  it("does not flag the mind's own long-lived token as script-issued", async () => {
    await addMind(OTHER_MIND, 4701);
    await getOrCreateMindUser(OTHER_MIND);
    const token = generateMindToken(OTHER_MIND);
    const app = new Hono();
    let seen: Principal | null = null;
    app.get("/probe", async (c) => {
      seen = await resolvePrincipal(c);
      return c.json({ ok: true });
    });
    await app.request("/probe", { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(seen?.user.username, OTHER_MIND);
    // The agent process holds this credential and anything it runs inherits it, so it
    // must never read as daemon-minted evidence of self-initiated work.
    assert.equal(seen?.viaScript ?? false, false);
  });
});

// ── Guard-level behaviour: the shape the issue asked for end to end ────────────

function guardedApp() {
  const app = new Hono();
  app.use("/api/*", authMiddleware);
  app.get("/api/minds/:name/info", requireSelf(), (c) => c.json({ ok: true }));
  // The allowlist shape: what GET /:name/seed-check and the other tending routes carry.
  app.get("/api/minds/:name/seed-check", requireSelfOrSpirit(), (c) => c.json({ ok: true }));
  app.post("/api/minds", requireAdmin, (c) => c.json({ ok: true }));
  app.get("/api/admin-only", requireAdmin, (c) => c.json({ ok: true }));
  return app;
}

describe("spirit privilege scoping at the guards (#433 / #1017)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  async function spiritToken(): Promise<string> {
    await spiritUser();
    invalidateMindUserCache(SPIRIT);
    return generateMindToken(SPIRIT);
  }

  it("refuses another mind's data when a non-admin asked the spirit for it", async () => {
    const token = await spiritToken();
    await addMind(OTHER_MIND, 4701);
    await addMind(ASKING_MIND, 4702);
    await getOrCreateMindUser(ASKING_MIND);
    await openTurn(`@${ASKING_MIND}`, [{ type: "inbound", sender: ASKING_MIND }]);

    const res = await guardedApp().request(`/api/minds/${OTHER_MIND}/info`, {
      headers: { Authorization: `Bearer ${token}`, "X-Volute-Thread": `@${ASKING_MIND}` },
    });
    assert.equal(res.status, 403);
  });

  it("still lets the spirit reach its own routes while acting for someone else", async () => {
    const token = await spiritToken();
    await addMind(ASKING_MIND, 4702);
    await getOrCreateMindUser(ASKING_MIND);
    await openTurn(`@${ASKING_MIND}`, [{ type: "inbound", sender: ASKING_MIND }]);

    // The spirit reports its own events mid-delegation; losing its own scope to a
    // borrowed one would 403 its history for the length of every conversation.
    const res = await guardedApp().request(`/api/minds/${SPIRIT}/info`, {
      headers: { Authorization: `Bearer ${token}`, "X-Volute-Thread": `@${ASKING_MIND}` },
    });
    assert.equal(res.status, 200);
  });

  it("lets a mind reach its own routes through the spirit, but no further", async () => {
    const token = await spiritToken();
    await addMind(ASKING_MIND, 4702);
    await addMind(OTHER_MIND, 4701);
    await getOrCreateMindUser(ASKING_MIND);
    await openTurn(`@${ASKING_MIND}`, [{ type: "inbound", sender: ASKING_MIND }]);
    const app = guardedApp();
    const headers = { Authorization: `Bearer ${token}`, "X-Volute-Thread": `@${ASKING_MIND}` };

    // Borrowed authority is exactly the requester's own — no more, and no less.
    assert.equal((await app.request(`/api/minds/${ASKING_MIND}/info`, { headers })).status, 200);
    assert.equal((await app.request(`/api/minds/${OTHER_MIND}/info`, { headers })).status, 403);
  });

  // #421's actual dependency, in the shape it runs in: the nurture schedule calls
  // `volute seed check <seed>`, which is GET /:name/seed-check — a requireSelfOrSpirit
  // allowlist route on a mind that is not the spirit. Both roads into self-initiated
  // work (a schedule turn, and a daemon-spawned script with no turn at all) must clear
  // it, or nurture regresses exactly the way #421 described.
  it("keeps the allowlist open to self-initiated work, from a schedule and a script", async () => {
    const token = await spiritToken();
    await addMind(OTHER_MIND, 4701);
    await openTurn("main", [{ type: "event", kind: "schedule" }]);
    const fromSchedule = await guardedApp().request(`/api/minds/${OTHER_MIND}/seed-check`, {
      headers: { Authorization: `Bearer ${token}`, "X-Volute-Thread": "main" },
    });
    assert.equal(fromSchedule.status, 200);

    // A scheduled script has no turn at all; its authority is the script token.
    await clearMind(SPIRIT);
    const scriptToken = (await buildMindScriptEnv(SPIRIT, mindDir(SPIRIT))).VOLUTE_MIND_TOKEN;
    assert.ok(scriptToken);
    try {
      const fromScript = await guardedApp().request(`/api/minds/${OTHER_MIND}/seed-check`, {
        headers: { Authorization: `Bearer ${scriptToken}` },
      });
      assert.equal(fromScript.status, 200);
    } finally {
      revokeScriptToken(scriptToken);
    }
  });

  // The #1020 outer wall, restated with tiers in play: the spirit's cross-mind route
  // reach is the requireSelfOrSpirit allowlist and nothing else, even on its own
  // self-initiated (`system`) work. A blanket requireSelf pass for the system tier
  // would hand a schedule-fired turn every mind's env and files — "read secrets",
  // exactly what the allowlist bound excludes.
  it("does not widen requireSelf for the spirit's self-initiated work", async () => {
    const token = await spiritToken();
    await addMind(OTHER_MIND, 4701);
    await openTurn("main", [{ type: "event", kind: "schedule" }]);
    const res = await guardedApp().request(`/api/minds/${OTHER_MIND}/info`, {
      headers: { Authorization: `Bearer ${token}`, "X-Volute-Thread": "main" },
    });
    assert.equal(res.status, 403);
  });

  it("refuses mind creation to a spirit turn a mind triggered", async () => {
    const token = await spiritToken();
    await addMind(ASKING_MIND, 4702);
    await getOrCreateMindUser(ASKING_MIND);
    await openTurn(`@${ASKING_MIND}`, [{ type: "inbound", sender: ASKING_MIND }]);

    const res = await guardedApp().request("/api/minds", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "X-Volute-Thread": `@${ASKING_MIND}` },
    });
    assert.equal(res.status, 403);
  });

  it("allows mind creation when a verified admin triggered the turn", async () => {
    const token = await spiritToken();
    const admin = await createUser(ADMIN, "pass");
    await openTurn(`@${ADMIN}`, [{ type: "inbound", sender: admin.username }]);
    // The affordance #1017 restores: an admin asks the spirit for a mind, and the
    // spirit's request runs with that admin's own authority.
    const res = await guardedApp().request("/api/minds", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "X-Volute-Thread": `@${ADMIN}` },
    });
    assert.equal(res.status, 200);
  });

  it("refuses mind creation to the spirit's own self-initiated work", async () => {
    const token = await spiritToken();
    await openTurn("main", [{ type: "event", kind: "schedule" }]);
    // The `system` tier is structurally self-reachable — the spirit configures its own
    // schedules — so gating mind creation on it would gate it on nothing. It is the
    // crash-the-host vector, and it stays admin-gated (#433).
    const res = await guardedApp().request("/api/minds", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "X-Volute-Thread": "main" },
    });
    assert.equal(res.status, 403);
  });

  it("keeps strict-admin routes closed to the spirit's own self-initiated work", async () => {
    const token = await spiritToken();
    await openTurn("main", [{ type: "event", kind: "schedule" }]);
    // requireAdmin has always 403'd the spirit; scoping must not widen it. Only a
    // verified admin behind the turn opens these.
    const selfInitiated = await guardedApp().request("/api/admin-only", {
      headers: { Authorization: `Bearer ${token}`, "X-Volute-Thread": "main" },
    });
    assert.equal(selfInitiated.status, 403);

    await clearMind(SPIRIT);
    const admin = await createUser(ADMIN, "pass");
    await openTurn(`@${ADMIN}`, [{ type: "inbound", sender: admin.username }]);
    const onBehalf = await guardedApp().request("/api/admin-only", {
      headers: { Authorization: `Bearer ${token}`, "X-Volute-Thread": `@${ADMIN}` },
    });
    assert.equal(onBehalf.status, 200);
  });

  it("leaves an ordinary mind's and an admin's own access unchanged", async () => {
    await addMind(OTHER_MIND, 4701);
    await getOrCreateMindUser(OTHER_MIND);
    const mindToken = generateMindToken(OTHER_MIND);
    const app = guardedApp();

    assert.equal(
      (
        await app.request(`/api/minds/${OTHER_MIND}/info`, {
          headers: { Authorization: `Bearer ${mindToken}` },
        })
      ).status,
      200,
    );
    await addMind(ASKING_MIND, 4702);
    assert.equal(
      (
        await app.request(`/api/minds/${ASKING_MIND}/info`, {
          headers: { Authorization: `Bearer ${mindToken}` },
        })
      ).status,
      403,
    );

    const admin = await createUser(ADMIN, "pass");
    const sessionId = await createSession(admin.id);
    assert.equal(
      (
        await app.request(`/api/minds/${OTHER_MIND}/info`, {
          headers: { Cookie: `volute_session=${sessionId}` },
        })
      ).status,
      200,
    );

    // A second human registers as "pending" and must be approved before they count.
    const plain = await createUser(PLAIN, "pass");
    await approveUser(plain.id);
    const plainSession = await createSession(plain.id);
    assert.equal(
      (
        await app.request(`/api/minds/${OTHER_MIND}/info`, {
          headers: { Cookie: `volute_session=${plainSession}` },
        })
      ).status,
      403,
    );
  });
});
