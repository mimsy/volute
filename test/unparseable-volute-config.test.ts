import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { addMind, mindDir, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import { sessions, users } from "../packages/daemon/src/lib/schema.js";

// A mind's volute.json that no longer parses is refused rather than overwritten (it holds
// the mind's profile, schedules and sleep), and every route that would update it answers
// with a handled 409 naming the file — never a bare 500, never a half-applied change.
describe("routes against an unparseable volute.json", () => {
  const name = `unparseable-config-${Date.now()}`;
  const broken = "{ not json";
  let cookie: string;
  let configPath: string;

  before(async () => {
    const db = await getDb();
    const [user] = await db
      .insert(users)
      .values({ username: "unparseable-admin", password_hash: "x", role: "admin" })
      .returning();
    const sessionId = crypto.randomUUID();
    await db.insert(sessions).values({ id: sessionId, userId: user.id, createdAt: Date.now() });
    cookie = `volute_session=${sessionId}`;

    await addMind(name, 4377);
    const home = join(mindDir(name), "home");
    mkdirSync(join(home, ".config"), { recursive: true });
    configPath = join(home, ".config", "volute.json");
    writeFileSync(configPath, broken);
    writeFileSync(join(home, "avatar.png"), "old");
  });

  after(async () => {
    const db = await getDb();
    await db.delete(users).where(eq(users.username, "unparseable-admin"));
    await removeMind(name);
    rmSync(mindDir(name), { recursive: true, force: true });
  });

  async function request(path: string, init: RequestInit) {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    return app.request(`/api/v1/minds/${name}${path}`, {
      ...init,
      headers: { Cookie: cookie, ...(init.headers ?? {}) },
    });
  }

  it("sleep config and schedules answer 409 and leave the file alone", async () => {
    const json = { "Content-Type": "application/json" };
    const sleep = await request("/sleep/config", {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(sleep.status, 409, await sleep.clone().text());
    assert.match(((await sleep.json()) as { error: string }).error, /unparseable/);

    const add = await request("/schedules", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ id: "x", cron: "0 9 * * *", message: "hi" }),
    });
    assert.equal(add.status, 409, await add.clone().text());
    assert.equal(readFileSync(configPath, "utf-8"), broken);
  });

  it("an avatar upload refuses before deleting the old avatar or writing a new one", async () => {
    const form = new FormData();
    form.append("file", new File([Buffer.from("png")], "me.gif", { type: "image/gif" }));
    // Same-origin, as the dashboard sends it (the CSRF guard refuses a cross-origin form).
    const res = await request("/avatar", {
      method: "POST",
      headers: { Origin: "http://localhost" },
      body: form,
    });
    assert.equal(res.status, 409, await res.clone().text());
    assert.ok(existsSync(join(mindDir(name), "home", "avatar.png")), "old avatar kept");
    assert.ok(!existsSync(join(mindDir(name), "home", "avatar.gif")), "nothing new written");
    assert.equal(readFileSync(configPath, "utf-8"), broken);
  });
});
