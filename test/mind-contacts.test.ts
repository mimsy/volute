import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq, sql } from "drizzle-orm";
import { createUser, getOrCreateMindUser } from "../packages/daemon/src/lib/auth.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { mindHistory, users } from "../packages/daemon/src/lib/schema.js";
import { createSession, deleteSession } from "../packages/daemon/src/web/middleware/auth.js";

const ADMIN_USERNAME = "contacts-test-admin";
let adminCookie: string;

type ContactRow = {
  channel: string | null;
  last_at: string;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  message_count: number;
  last_sender: string | null;
};

type ContactsResponse = { hours: number; contacts: ContactRow[] };

/** DB timestamp form (UTC, no trailing Z): "YYYY-MM-DD HH:MM:SS". */
function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString().replace("T", " ").slice(0, 19);
}

async function cleanup() {
  const db = await getDb();
  await db.delete(users).where(eq(users.username, ADMIN_USERNAME));
  await db.delete(users).where(sql`username LIKE 'test-contacts-%'`);
  await db.delete(mindHistory).where(sql`mind LIKE 'test-contacts-%'`);
}

async function mindSession(mindName: string): Promise<string> {
  const user = await getOrCreateMindUser(mindName);
  return createSession(user.id);
}

async function fetchContacts(mind: string, cookie: string, query = "") {
  const { default: app } = await import("../packages/daemon/src/web/app.js");
  const res = await app.request(`/api/v1/minds/${mind}/history/contacts${query}`, {
    headers: { Cookie: `volute_session=${cookie}` },
  });
  return res;
}

describe("GET /api/v1/minds/:name/history/contacts", () => {
  beforeEach(async () => {
    await cleanup();
    const admin = await createUser(ADMIN_USERNAME, "pass");
    adminCookie = await createSession(admin.id);
  });
  afterEach(async () => {
    if (adminCookie) deleteSession(adminCookie);
    await cleanup();
  });

  it("aggregates channels newest-first with counts and counterparty", async () => {
    const db = await getDb();
    const mind = "test-contacts-lyra";
    await db.insert(mindHistory).values([
      // A recent, active DM with atlas — inbound + outbound.
      { mind, type: "outbound", channel: "@atlas", content: "hi", created_at: ago(20) },
      {
        mind,
        type: "inbound",
        channel: "@atlas",
        sender: "atlas",
        content: "hey",
        created_at: ago(18),
      },
      { mind, type: "outbound", channel: "@atlas", content: "how are you", created_at: ago(5) },
      // An older brush with #system.
      {
        mind,
        type: "inbound",
        channel: "#system",
        sender: "volute",
        content: "welcome",
        created_at: ago(120),
      },
    ]);

    const res = await fetchContacts(mind, adminCookie);
    assert.equal(res.status, 200);
    const body = (await res.json()) as ContactsResponse;
    assert.equal(body.hours, 48);

    // Newest-contacted channel first.
    assert.equal(body.contacts[0].channel, "@atlas");
    assert.equal(body.contacts[1].channel, "#system");

    const atlas = body.contacts[0];
    assert.equal(atlas.message_count, 3);
    assert.equal(atlas.last_sender, "atlas", "counterparty is the last inbound sender");
    assert.ok(atlas.last_inbound_at, "records a last inbound time");
    assert.ok(atlas.last_outbound_at, "records a last outbound time");
    // Most recent message on @atlas was the outbound at ~5m ago.
    assert.ok(atlas.last_at >= atlas.last_inbound_at!);
  });

  it("respects the hours window", async () => {
    const db = await getDb();
    const mind = "test-contacts-window";
    await db.insert(mindHistory).values([
      { mind, type: "outbound", channel: "@fresh", content: "recent", created_at: ago(30) },
      { mind, type: "outbound", channel: "@stale", content: "old", created_at: ago(60 * 5) },
    ]);

    const res = await fetchContacts(mind, adminCookie, "?hours=1");
    assert.equal(res.status, 200);
    const body = (await res.json()) as ContactsResponse;
    assert.equal(body.hours, 1);
    const channels = body.contacts.map((c) => c.channel);
    assert.deepEqual(channels, ["@fresh"], "channels outside the window are excluded");
  });

  it("returns empty contacts when nothing is in the window", async () => {
    const res = await fetchContacts("test-contacts-nobody", adminCookie);
    assert.equal(res.status, 200);
    const body = (await res.json()) as ContactsResponse;
    assert.deepEqual(body.contacts, []);
  });

  it("a mind can read its own contacts", async () => {
    const db = await getDb();
    const mind = "test-contacts-self";
    await db
      .insert(mindHistory)
      .values({ mind, type: "outbound", channel: "@peer", content: "hi", created_at: ago(10) });

    const cookie = await mindSession(mind);
    const res = await fetchContacts(mind, cookie);
    assert.equal(res.status, 200);
    const body = (await res.json()) as ContactsResponse;
    assert.equal(body.contacts[0].channel, "@peer");
    deleteSession(cookie);
  });

  it("a mind cannot read another mind's contacts", async () => {
    const cookie = await mindSession("test-contacts-alice");
    const res = await fetchContacts("test-contacts-bob", cookie);
    assert.equal(res.status, 403);
    deleteSession(cookie);
  });

  it("requires authentication", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request("/api/v1/minds/test-contacts-x/history/contacts");
    assert.equal(res.status, 401);
  });
});
