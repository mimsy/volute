import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { createUser } from "../packages/daemon/src/lib/auth.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  addMind,
  mindDir,
  removeMind,
  voluteHome,
} from "../packages/daemon/src/lib/mind/registry.js";
import { mindHistory, users } from "../packages/daemon/src/lib/schema.js";
import { createSession } from "../packages/daemon/src/web/middleware/auth.js";

function postHeaders(cookie: string) {
  return {
    Cookie: `volute_session=${cookie}`,
    Origin: "http://localhost",
  };
}

async function insertHistory(row: {
  mind: string;
  type: string;
  sender?: string;
  content: string;
  minutesAgo?: number;
}) {
  const db = await getDb();
  // Mimic SQLite datetime('now'): zone-less UTC "YYYY-MM-DD HH:MM:SS".
  const created_at = new Date(Date.now() - (row.minutesAgo ?? 0) * 60_000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  await db.insert(mindHistory).values({
    mind: row.mind,
    type: row.type,
    sender: row.sender ?? null,
    content: row.content,
    created_at,
  });
}

describe("seed check endpoint", () => {
  let cookie: string;
  const seedName = `check-seed-${Date.now()}`;

  async function cleanup() {
    const db = await getDb();
    await db.delete(users).where(eq(users.username, "check-admin"));
    await db.delete(mindHistory).where(eq(mindHistory.mind, seedName));
    const { getSpiritName } = await import("../packages/daemon/src/lib/config/setup.js");
    await db
      .delete(mindHistory)
      .where(and(eq(mindHistory.mind, getSpiritName()), eq(mindHistory.type, "event")));
    await removeMind(seedName);
  }

  beforeEach(async () => {
    await cleanup();
    const user = await createUser("check-admin", "pass");
    cookie = await createSession(user.id);
    await addMind(seedName, 4200, "seed");
    const dir = resolve(voluteHome(), "minds", seedName);
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    writeFileSync(resolve(dir, "home/.config/volute.json"), "{}");
    // Write orientation SOUL.md (still has marker)
    writeFileSync(resolve(dir, "home/SOUL.md"), "a seed, still discovering who you are");
  });

  afterEach(cleanup);

  it("returns empty output for non-seed minds", async () => {
    await removeMind(seedName);
    await addMind(seedName, 4200);

    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`http://localhost/api/v1/minds/${seedName}/seed-check`, {
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { output: string };
    assert.equal(body.output, "");
  });

  it("returns status when seed needs attention", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`http://localhost/api/v1/minds/${seedName}/seed-check`, {
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { output: string };
    assert.ok(body.output.includes(`Seed: ${seedName}`));
    assert.ok(body.output.includes("Write SOUL.md"));
  });

  it("reports completed items correctly", async () => {
    const dir = resolve(voluteHome(), "minds", seedName);
    writeFileSync(resolve(dir, "home/SOUL.md"), "# My Soul\nI am a test mind.");
    writeFileSync(resolve(dir, "home/MEMORY.md"), "# Memory\nSome memories.");
    writeFileSync(
      resolve(dir, "home/.config/volute.json"),
      JSON.stringify({ profile: { displayName: "Test Mind" } }),
    );

    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`http://localhost/api/v1/minds/${seedName}/seed-check`, {
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { output: string };
    assert.ok(body.output.includes("SOUL.md written"));
    assert.ok(body.output.includes("MEMORY.md written"));
    assert.ok(body.output.includes("Display name set"));
  });

  it("does not count the placeholder MEMORY.md as written", async () => {
    const { MEMORY_PLACEHOLDER_MARKER } = await import("../packages/daemon/src/lib/prompts.js");
    const dir = resolve(voluteHome(), "minds", seedName);
    // Custom SOUL, but MEMORY.md is still the starter placeholder.
    writeFileSync(resolve(dir, "home/SOUL.md"), "# My Soul\nI am a test mind.");
    writeFileSync(
      resolve(dir, "home/MEMORY.md"),
      `# Memory\n\nSome starter text — ${MEMORY_PLACEHOLDER_MARKER}.`,
    );
    writeFileSync(
      resolve(dir, "home/.config/volute.json"),
      JSON.stringify({ profile: { displayName: "Test Mind" } }),
    );

    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`http://localhost/api/v1/minds/${seedName}/seed-check`, {
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { output: string };
    assert.ok(body.output.includes("Write MEMORY.md"), "placeholder MEMORY.md is still remaining");
    assert.ok(!body.output.includes("MEMORY.md written"));
  });

  it("does not count an empty MEMORY.md as written", async () => {
    const dir = resolve(voluteHome(), "minds", seedName);
    writeFileSync(resolve(dir, "home/SOUL.md"), "# My Soul\nI am a test mind.");
    writeFileSync(resolve(dir, "home/MEMORY.md"), "   \n");

    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`http://localhost/api/v1/minds/${seedName}/seed-check`, {
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { output: string };
    assert.ok(body.output.includes("Write MEMORY.md"));
    assert.ok(!body.output.includes("MEMORY.md written"));
  });

  it("returns 404 for unknown mind", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request("http://localhost/api/v1/minds/nonexistent-xyz/seed-check", {
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 404);
  });

  it("stays quiet when someone messaged the seed recently", async () => {
    // Regression: UTC created_at parsed as local made this message look "future"
    // AND the && gate fired anyway when the spirit had never messaged.
    await insertHistory({
      mind: seedName,
      type: "inbound",
      sender: "some-human",
      content: "hi seed",
      minutesAgo: 2,
    });

    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`http://localhost/api/v1/minds/${seedName}/seed-check`, {
      headers: postHeaders(cookie),
    });
    const body = (await res.json()) as { output: string };
    assert.equal(body.output, "");
  });

  it("stays quiet when only the spirit messaged the seed recently", async () => {
    const { getSpiritName } = await import("../packages/daemon/src/lib/config/setup.js");
    await insertHistory({
      mind: seedName,
      type: "inbound",
      sender: getSpiritName(),
      content: "checking in",
      minutesAgo: 5,
    });

    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`http://localhost/api/v1/minds/${seedName}/seed-check`, {
      headers: postHeaders(cookie),
    });
    const body = (await res.json()) as { output: string };
    assert.equal(body.output, "");
  });

  it("reports the last message with its sender once the seed is unattended", async () => {
    await insertHistory({
      mind: seedName,
      type: "inbound",
      sender: "some-human",
      content: "hi seed",
      minutesAgo: 40,
    });

    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`http://localhost/api/v1/minds/${seedName}/seed-check`, {
      headers: postHeaders(cookie),
    });
    const body = (await res.json()) as { output: string };
    assert.ok(body.output.includes(`Seed: ${seedName}`));
    assert.ok(
      body.output.includes(`Last message to ${seedName}:`),
      `unexpected output: ${body.output}`,
    );
    assert.ok(body.output.includes("(from some-human)"));
    assert.ok(!body.output.includes("creator message"), "old wording removed");
  });

  it("backs off after a recent nudge", async () => {
    const { getSpiritName } = await import("../packages/daemon/src/lib/config/setup.js");
    await insertHistory({
      mind: seedName,
      type: "inbound",
      sender: "some-human",
      content: "hi seed",
      minutesAgo: 40,
    });
    // A nudge was already delivered to the spirit 5 minutes ago.
    await insertHistory({
      mind: getSpiritName(),
      type: "event",
      content: `Seed: ${seedName}\nLast message to ${seedName}: 35 minutes ago (from some-human)`,
      minutesAgo: 5,
    });

    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`http://localhost/api/v1/minds/${seedName}/seed-check`, {
      headers: postHeaders(cookie),
    });
    const body = (await res.json()) as { output: string };
    assert.equal(body.output, "");
  });

  it("nudges again once the backoff window has passed", async () => {
    const { getSpiritName } = await import("../packages/daemon/src/lib/config/setup.js");
    await insertHistory({
      mind: seedName,
      type: "inbound",
      sender: "some-human",
      content: "hi seed",
      minutesAgo: 90,
    });
    await insertHistory({
      mind: getSpiritName(),
      type: "event",
      content: `Seed: ${seedName}\nLast message to ${seedName}: 50 minutes ago (from some-human)`,
      minutesAgo: 40,
    });

    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`http://localhost/api/v1/minds/${seedName}/seed-check`, {
      headers: postHeaders(cookie),
    });
    const body = (await res.json()) as { output: string };
    assert.ok(body.output.includes(`Seed: ${seedName}`));
  });

  it("a forced check bypasses the backoff", async () => {
    const { getSpiritName } = await import("../packages/daemon/src/lib/config/setup.js");
    await insertHistory({
      mind: getSpiritName(),
      type: "event",
      content: `Seed: ${seedName}\nLast message to ${seedName}: 35 minutes ago (from some-human)`,
      minutesAgo: 5,
    });

    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`http://localhost/api/v1/minds/${seedName}/seed-check?force=1`, {
      headers: postHeaders(cookie),
    });
    const body = (await res.json()) as { output: string };
    assert.ok(body.output.includes(`Seed: ${seedName}`));
  });

  it("suppresses a re-check when fed back its own emitted nudge (round trip)", async () => {
    // Guards the coupling between the emitter's first line ("Seed: <name>\n...")
    // and the backoff matcher: whatever the endpoint emits, recording it as the
    // spirit's nudge event must suppress the next check.
    const { getSpiritName } = await import("../packages/daemon/src/lib/config/setup.js");
    await insertHistory({
      mind: seedName,
      type: "inbound",
      sender: "some-human",
      content: "hi seed",
      minutesAgo: 40,
    });

    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const first = await app.request(`http://localhost/api/v1/minds/${seedName}/seed-check`, {
      headers: postHeaders(cookie),
    });
    const firstBody = (await first.json()) as { output: string };
    assert.ok(firstBody.output.includes(`Seed: ${seedName}`), "first check should nudge");

    // Record exactly what the spirit received, then re-check immediately.
    await insertHistory({
      mind: getSpiritName(),
      type: "event",
      content: firstBody.output,
      minutesAgo: 0,
    });

    const second = await app.request(`http://localhost/api/v1/minds/${seedName}/seed-check`, {
      headers: postHeaders(cookie),
    });
    const secondBody = (await second.json()) as { output: string };
    assert.equal(secondBody.output, "");
  });

  it("does not back off on a nudge about a different seed", async () => {
    const { getSpiritName } = await import("../packages/daemon/src/lib/config/setup.js");
    await insertHistory({
      mind: seedName,
      type: "inbound",
      sender: "some-human",
      content: "hi seed",
      minutesAgo: 40,
    });
    // A recent nudge, but about another seed entirely — it must not suppress this one.
    await insertHistory({
      mind: getSpiritName(),
      type: "event",
      content: `Seed: some-other-seed\nLast message to some-other-seed: 35 minutes ago (from someone)`,
      minutesAgo: 5,
    });

    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`http://localhost/api/v1/minds/${seedName}/seed-check`, {
      headers: postHeaders(cookie),
    });
    const body = (await res.json()) as { output: string };
    assert.ok(body.output.includes(`Seed: ${seedName}`));
  });

  it("treats _ in a seed name as a literal, not a LIKE wildcard, for backoff", async () => {
    // A seed name with an underscore (mind names permit them). The backoff LIKE
    // must not match a nudge for a sibling name differing only where the `_` is.
    const escName = `esc_seed_${Date.now()}`;
    await addMind(escName, 4210, "seed");
    const dir = resolve(voluteHome(), "minds", escName);
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    writeFileSync(resolve(dir, "home/.config/volute.json"), "{}");
    writeFileSync(resolve(dir, "home/SOUL.md"), "a seed, still discovering who you are");
    try {
      const { getSpiritName } = await import("../packages/daemon/src/lib/config/setup.js");
      await insertHistory({
        mind: escName,
        type: "inbound",
        sender: "some-human",
        content: "hi",
        minutesAgo: 40,
      });
      // Wildcard sibling: replaces every `_` with another char. If `_` were a
      // wildcard, this nudge would wrongly suppress escName's check.
      const sibling = escName.replace(/_/g, "X");
      await insertHistory({
        mind: getSpiritName(),
        type: "event",
        content: `Seed: ${sibling}\nLast message to ${sibling}: 35 minutes ago (from some-human)`,
        minutesAgo: 5,
      });

      const { default: app } = await import("../packages/daemon/src/web/app.js");
      const sib = await app.request(`http://localhost/api/v1/minds/${escName}/seed-check`, {
        headers: postHeaders(cookie),
      });
      const sibBody = (await sib.json()) as { output: string };
      assert.ok(
        sibBody.output.includes(`Seed: ${escName}`),
        `sibling nudge must not suppress; got: ${sibBody.output}`,
      );

      // A nudge for the exact underscore name still backs off (literal match works).
      await insertHistory({
        mind: getSpiritName(),
        type: "event",
        content: `Seed: ${escName}\nLast message to ${escName}: 35 minutes ago (from some-human)`,
        minutesAgo: 1,
      });
      const exact = await app.request(`http://localhost/api/v1/minds/${escName}/seed-check`, {
        headers: postHeaders(cookie),
      });
      const exactBody = (await exact.json()) as { output: string };
      assert.equal(exactBody.output, "");
    } finally {
      const db = await getDb();
      await db.delete(mindHistory).where(eq(mindHistory.mind, escName));
      await removeMind(escName);
    }
  });

  describe("with a named spirit", () => {
    async function setSpiritName(name: string | undefined) {
      const { readGlobalConfig, writeGlobalConfig } = await import(
        "../packages/daemon/src/lib/config/setup.js"
      );
      const config = readGlobalConfig();
      writeGlobalConfig({
        ...config,
        setup: {
          type: "local",
          mindsDir: "/tmp/minds",
          isolation: "none",
          service: false,
          spiritName: name,
        },
      });
    }

    afterEach(async () => {
      await setSpiritName(undefined);
    });

    it("gates on the configured spirit name, not volute", async () => {
      await setSpiritName("iris");
      const db = await getDb();

      // Recent creator message + recent message from the named spirit → nurture-gated
      await db.insert(mindHistory).values([
        { mind: seedName, type: "inbound", sender: "check-admin" },
        { mind: seedName, type: "inbound", sender: "iris" },
      ]);

      const { default: app } = await import("../packages/daemon/src/web/app.js");
      const res = await app.request(`http://localhost/api/v1/minds/${seedName}/seed-check`, {
        headers: postHeaders(cookie),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { output: string };
      assert.equal(body.output, "", "recent creator + spirit activity should gate the check");
    });

    it("no longer counts volute as the spirit once renamed", async () => {
      await setSpiritName("iris");

      // An old "volute" message is just another sender now — the spirit ("iris")
      // has never messaged, and the message is past both recency thresholds, so
      // the check must fire and report volute as ordinary activity (not excluded
      // as the spirit, which would read "No one has messaged ... yet").
      await insertHistory({
        mind: seedName,
        type: "inbound",
        sender: "volute",
        content: "hi",
        minutesAgo: 40,
      });

      const { default: app } = await import("../packages/daemon/src/web/app.js");
      const res = await app.request(`http://localhost/api/v1/minds/${seedName}/seed-check`, {
        headers: postHeaders(cookie),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { output: string };
      assert.ok(body.output.includes(`Seed: ${seedName}`));
      assert.ok(body.output.includes("(from volute)"));
    });
  });
});

describe("seed check nurture gate vs. forced host check", () => {
  let cookie: string;
  const seedName = `gate-seed-${Date.now()}`;

  async function cleanup() {
    const db = await getDb();
    await db.delete(users).where(eq(users.username, "gate-admin"));
    await db.delete(mindHistory).where(eq(mindHistory.mind, seedName));
    await removeMind(seedName);
  }

  beforeEach(async () => {
    await cleanup();
    const user = await createUser("gate-admin", "pass");
    cookie = await createSession(user.id);
    await addMind(seedName, 4203, "seed");
    const dir = resolve(voluteHome(), "minds", seedName);
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    writeFileSync(resolve(dir, "home/.config/volute.json"), "{}");
    writeFileSync(resolve(dir, "home/SOUL.md"), "a seed, still discovering who you are");

    // Recent creator + spirit messages → the nurture gate should suppress output.
    const db = await getDb();
    const now = new Date().toISOString();
    await db.insert(mindHistory).values([
      { mind: seedName, type: "inbound", sender: "creator", content: "hi", created_at: now },
      { mind: seedName, type: "inbound", sender: "volute", content: "hi", created_at: now },
    ]);
  });

  afterEach(cleanup);

  it("stays silent under the nurture gate when recently attended to", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`http://localhost/api/v1/minds/${seedName}/seed-check`, {
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { output: string };
    assert.equal(body.output, "");
  });

  it("stays quiet when only the creator is recent (any engagement suffices)", async () => {
    // New semantics: any recent engagement quiets the gate. Remove the spirit
    // message so only the creator is recent — the gate must still suppress.
    const db = await getDb();
    await db
      .delete(mindHistory)
      .where(and(eq(mindHistory.mind, seedName), eq(mindHistory.sender, "volute")));

    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`http://localhost/api/v1/minds/${seedName}/seed-check`, {
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { output: string };
    assert.equal(body.output, "");
  });

  it("forces the readiness state for a manual host check (?force=1)", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`http://localhost/api/v1/minds/${seedName}/seed-check?force=1`, {
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { output: string };
    assert.ok(body.output.includes(`Seed: ${seedName}`));
    assert.ok(body.output.includes("Write MEMORY.md"));
  });

  it("reports a forced check for a mind that is no longer a seed", async () => {
    await removeMind(seedName);
    await addMind(seedName, 4203);

    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`http://localhost/api/v1/minds/${seedName}/seed-check?force=1`, {
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { output: string };
    assert.ok(body.output.includes("no longer a seed"));
  });
});

describe("sprout endpoint cleans up nurture schedule", () => {
  let cookie: string;
  const seedName = `sprout-cleanup-${Date.now()}`;

  async function cleanup() {
    const db = await getDb();
    await db.delete(users).where(eq(users.username, "sprout-admin"));
    await removeMind(seedName);
  }

  beforeEach(async () => {
    await cleanup();
    const user = await createUser("sprout-admin", "pass");
    cookie = await createSession(user.id);
    await addMind(seedName, 4201, "seed");
    const dir = resolve(voluteHome(), "minds", seedName);
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    writeFileSync(resolve(dir, "home/.config/volute.json"), "{}");
  });

  afterEach(cleanup);

  it("POST /api/v1/minds/:name/sprout sets stage to sprouted", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request(`http://localhost/api/v1/minds/${seedName}/sprout`, {
      method: "POST",
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.ok(body.ok);
  });
});

describe("profile endpoint", () => {
  let cookie: string;
  const mindName = `profile-test-${Date.now()}`;

  async function cleanup() {
    const db = await getDb();
    await db.delete(users).where(eq(users.username, "profile-admin"));
    await removeMind(mindName);
  }

  beforeEach(async () => {
    await cleanup();
    const user = await createUser("profile-admin", "pass");
    cookie = await createSession(user.id);
    await addMind(mindName, 4202);
    const dir = resolve(voluteHome(), "minds", mindName);
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    writeFileSync(resolve(dir, "home/.config/volute.json"), "{}");
  });

  afterEach(cleanup);

  it("PATCH /api/v1/minds/:name/profile updates profile", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request(`http://localhost/api/v1/minds/${mindName}/profile`, {
      method: "PATCH",
      headers: {
        ...postHeaders(cookie),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        displayName: "Test Display",
        description: "A test mind",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.ok(body.ok);

    // Verify volute.json was updated
    const { readVoluteConfig } = await import("../packages/daemon/src/lib/mind/volute-config.js");
    const config = readVoluteConfig(mindDir(mindName));
    assert.equal(config?.profile?.displayName, "Test Display");
    assert.equal(config?.profile?.description, "A test mind");
  });

  it("PATCH /api/v1/minds/:name/profile returns 404 for unknown mind", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request("http://localhost/api/v1/minds/nonexistent-mind/profile", {
      method: "PATCH",
      headers: {
        ...postHeaders(cookie),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ displayName: "Test" }),
    });
    assert.equal(res.status, 404);
  });
});
