import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { DeliveryManager } from "../packages/daemon/src/lib/delivery/delivery-manager.js";
import {
  clearConfigCache,
  type RoutingConfig,
  setRoutesChangeListener,
} from "../packages/daemon/src/lib/delivery/delivery-router.js";
import { addMind, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import { channelGates, deliveryQueue, mindHistory } from "../packages/daemon/src/lib/schema.js";

// --- Helpers ---

function mindName(): string {
  return `gated-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function writeRoutes(name: string, config: RoutingConfig | object): void {
  const dir = resolve(process.env.VOLUTE_HOME!, "minds", name);
  const configDir = resolve(dir, "home/.config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(resolve(configDir, "routes.json"), JSON.stringify(config));
  clearConfigCache(name);
}

function createMind(config: RoutingConfig | object): string {
  const name = mindName();
  const port = 20000 + Math.floor(Math.random() * 20000);
  addMind(name, port);
  writeRoutes(name, config);
  return name;
}

async function rows(name: string): Promise<(typeof deliveryQueue.$inferSelect)[]> {
  const db = await getDb();
  return db.select().from(deliveryQueue).where(eq(deliveryQueue.mind, name));
}

/** Build a manager whose notifications are captured and whose routes listener is inert. */
function makeManager(): { manager: DeliveryManager; notes: { mind: string; text: string }[] } {
  const manager = new DeliveryManager();
  // Neutralize the global routes-change listener so tests drive releaseGated directly.
  setRoutesChangeListener(() => {});
  const notes: { mind: string; text: string }[] = [];
  manager.setNotifier(async (mind, text) => {
    notes.push({ mind, text });
  });
  // Pretend the mind is up so redrive attempts delivery (which fails harmlessly).
  manager.setRunningCheck(() => false);
  return { manager, notes };
}

describe("gated-channel release (#537)", () => {
  let manager: DeliveryManager | undefined;
  let cleanup: string[] = [];

  afterEach(async () => {
    manager?.dispose();
    manager = undefined;
    const db = await getDb();
    for (const n of cleanup) {
      await db.delete(mindHistory).where(eq(mindHistory.mind, n));
      removeMind(n);
    }
    cleanup = [];
    clearConfigCache();
  });

  async function gate(mgr: DeliveryManager, name: string, channel: string, text = "hi") {
    return mgr.routeAndDeliver(name, { channel, sender: "alice", content: text });
  }

  describe("invite cadence", () => {
    it("fires exactly on the first message and every 10th thereafter", async () => {
      const name = createMind({ rules: [] });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      const fires: string[] = [];
      manager.setNotifier(async (_mind, text) => {
        if (text.includes("[New channel:")) fires.push(text);
      });

      for (let i = 0; i < 21; i++) await gate(manager, name, "discord:general");
      // counts 1..21 → notify at 1, 10, 20 → 3 fires
      assert.equal(fires.length, 3);

      // The first invite reads as "nobody has reached out here before"; later invites
      // carry the held-count context so the mind can tell a fresh ping from months of
      // silence (bug 3). Regressing heldLine back to one string must fail this.
      assert.ok(
        fires[0].includes("Someone new is reaching out"),
        "first invite uses the fresh-contact wording",
      );
      assert.ok(
        /\d+ messages from this channel are being held, unrouted/.test(fires[2]),
        "a repeat invite reports how many messages are held, unrouted",
      );
      assert.ok(
        !fires[2].includes("Someone new is reaching out"),
        "a repeat invite drops the fresh-contact wording",
      );
    });

    it("never notifies for a declined channel, but still records history", async () => {
      const name = createMind({ rules: [] });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      await manager.declineChannel(name, "discord:spam");
      m.notes.length = 0;

      for (let i = 0; i < 15; i++) await gate(manager, name, "discord:spam");

      assert.equal(
        m.notes.filter((n) => n.text.includes("[New channel:")).length,
        0,
        "declined channel never invites",
      );
      // History still persisted, but as inert archived rows (never re-surfaced as gated).
      const all = (await rows(name)).filter((r) => r.channel === "discord:spam");
      assert.equal(
        all.filter((r) => r.status === "gated").length,
        0,
        "declined channel accumulates no live gated rows",
      );
      assert.equal(
        all.filter((r) => r.status === "archived").length,
        15,
        "messages are archived (history preserved)",
      );
    });
  });

  describe("declineChannel", () => {
    it("archives currently-held rows and records declined state", async () => {
      const name = createMind({ rules: [] });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      for (let i = 0; i < 3; i++) await gate(manager, name, "discord:noise");
      const archived = await manager.declineChannel(name, "discord:noise");
      assert.equal(archived, 3, "returns count of archived rows");

      const all = await rows(name);
      assert.equal(all.filter((r) => r.status === "gated").length, 0, "no gated rows remain");
      assert.equal(all.filter((r) => r.status === "archived").length, 3, "held rows archived");

      const db = await getDb();
      const gateRow = await db
        .select()
        .from(channelGates)
        .where(and(eq(channelGates.mind, name), eq(channelGates.channel, "discord:noise")));
      assert.equal(gateRow[0]?.state, "declined");
    });
  });

  describe("releaseGated", () => {
    it("rewrites session to the newly-resolved route, not the gate-time fallback", async () => {
      // Gate with default 'main' (no rule matches discord:general).
      const name = createMind({ rules: [{ channel: "web", session: "web" }], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      await gate(manager, name, "discord:general");
      const before = await rows(name);
      assert.equal(before[0].session, "main", "gated at the fallback session");
      assert.equal(before[0].status, "gated");

      // Add a rule mapping the channel to a distinct session, then release.
      writeRoutes(name, {
        rules: [
          { channel: "web", session: "web" },
          { channel: "discord:*", session: "discord-inbox" },
        ],
        default: "main",
      });
      await manager.releaseGated(name);

      const after = await rows(name);
      const row = after.find((r) => r.channel === "discord:general");
      assert.ok(row);
      assert.equal(row.status, "pending", "promoted to pending");
      assert.equal(row.session, "discord-inbox", "session rewritten to the current route");
    });

    it("records a real inbound history row only when a gated message is released (#420)", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      await gate(manager, name, "discord:general", "hello there");

      const db = await getDb();
      const before = await db
        .select()
        .from(mindHistory)
        .where(and(eq(mindHistory.mind, name), eq(mindHistory.type, "inbound")));
      assert.equal(before.length, 0, "a gated message writes no inbound history row");

      writeRoutes(name, {
        rules: [{ channel: "discord:*", session: "inbox" }],
        default: "main",
      });
      await manager.releaseGated(name);

      const after = await db
        .select()
        .from(mindHistory)
        .where(and(eq(mindHistory.mind, name), eq(mindHistory.type, "inbound")));
      assert.equal(after.length, 1, "the released message is recorded as inbound exactly once");
      assert.equal(after[0].channel, "discord:general");
      assert.equal(after[0].content, "hello there");
    });

    it("expands a $new route to a generated session on release, not the literal '$new'", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      await gate(manager, name, "discord:general");

      writeRoutes(name, {
        rules: [{ channel: "discord:*", session: "$new" }],
        default: "main",
      });
      await manager.releaseGated(name);

      const after = await rows(name);
      const row = after.find((r) => r.channel === "discord:general");
      assert.ok(row);
      assert.equal(row.status, "pending", "promoted to pending");
      assert.notEqual(row.session, "$new", "the literal '$new' is never persisted");
      assert.match(row.session, /^new-/, "session expanded to a generated ephemeral name");
    });

    it("promotes at most N per channel (newest) and archives the remainder with one summary", async () => {
      const name = createMind({ rules: [{ channel: "web", session: "web" }], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      // 25 gated messages on one channel.
      for (let i = 0; i < 25; i++) await gate(manager, name, "discord:general", `msg ${i}`);
      m.notes.length = 0;

      writeRoutes(name, {
        rules: [
          { channel: "web", session: "web" },
          { channel: "discord:*", session: "discord" },
        ],
        default: "main",
      });
      await manager.releaseGated(name);

      const after = await rows(name);
      const pending = after.filter((r) => r.status === "pending");
      const archived = after.filter((r) => r.status === "archived");
      assert.equal(pending.length, 10, "at most 10 promoted");
      assert.equal(archived.length, 15, "the older 15 are archived");

      // The promoted rows are the newest (highest ids).
      const maxArchivedId = Math.max(...archived.map((r) => r.id));
      const minPendingId = Math.min(...pending.map((r) => r.id));
      assert.ok(minPendingId > maxArchivedId, "kept the newest rows");

      // One summary message, mentioning the truncation.
      const summaries = m.notes.filter((n) => n.text.includes("[Channel backlog released]"));
      assert.equal(summaries.length, 1, "exactly one summary, not a flood");
      assert.ok(summaries[0].text.includes("discord:general"));
      assert.ok(summaries[0].text.includes("15 earlier"));

      // Only the promoted (delivered) rows become inbound history — the archived 15 stay
      // inert and are never claimed as "received" (#420).
      const db = await getDb();
      const inbound = await db
        .select()
        .from(mindHistory)
        .where(and(eq(mindHistory.mind, name), eq(mindHistory.type, "inbound")));
      assert.equal(inbound.length, 10, "only the 10 delivered messages are recorded as inbound");
    });

    it("does not truncate or summarize when the backlog is within the limit", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      for (let i = 0; i < 3; i++) await gate(manager, name, "discord:general");
      m.notes.length = 0;

      writeRoutes(name, { rules: [{ channel: "discord:*", session: "discord" }], default: "main" });
      await manager.releaseGated(name);

      const after = await rows(name);
      assert.equal(after.filter((r) => r.status === "pending").length, 3);
      assert.equal(after.filter((r) => r.status === "archived").length, 0);
      assert.equal(
        m.notes.filter((n) => n.text.includes("[Channel backlog released]")).length,
        0,
        "no summary when nothing was truncated",
      );
    });

    it("skips declined channels — they stay gated even if a rule now matches", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      for (let i = 0; i < 3; i++) await gate(manager, name, "discord:general");
      // Decline archives the current 3; the 2 fresh messages after declining are
      // archived on arrival (never gated), so they never re-surface as actionable.
      await manager.declineChannel(name, "discord:general");
      for (let i = 0; i < 2; i++) await gate(manager, name, "discord:general");

      writeRoutes(name, { rules: [{ channel: "discord:*", session: "discord" }], default: "main" });
      await manager.releaseGated(name);

      const after = await rows(name);
      assert.equal(
        after.filter((r) => r.status === "pending").length,
        0,
        "declined channel is never promoted",
      );
      assert.equal(
        after.filter((r) => r.status === "gated").length,
        0,
        "a declined channel accumulates no live gated rows",
      );
      assert.equal(
        after.filter((r) => r.status === "archived").length,
        5,
        "all declined-channel messages are archived (inert)",
      );
    });

    it("archives file-destination matches instead of promoting them", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      await gate(manager, name, "logs:system");

      writeRoutes(name, {
        rules: [{ channel: "logs:*", destination: "file", path: "inbox/logs.md" }],
        default: "main",
      });
      await manager.releaseGated(name);

      const after = await rows(name);
      assert.equal(after.filter((r) => r.status === "pending").length, 0);
      assert.equal(after.filter((r) => r.status === "archived").length, 1, "file match archived");
    });

    it("leaves genuinely-unmatched channels gated", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      await gate(manager, name, "discord:general");

      // A rule that matches a different channel only.
      writeRoutes(name, { rules: [{ channel: "slack:*", session: "slack" }], default: "main" });
      await manager.releaseGated(name);

      const after = await rows(name);
      assert.equal(after.filter((r) => r.status === "gated").length, 1, "still held");
      assert.equal(after.filter((r) => r.status === "pending").length, 0);
    });
  });

  describe("archived rows are inert", () => {
    it("are invisible to getPending", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      for (let i = 0; i < 4; i++) await gate(manager, name, "discord:general");
      await manager.declineChannel(name, "discord:general"); // archives all 4

      const pending = await manager.getPending(name);
      assert.deepEqual(pending, [], "archived rows do not show as pending/gated");
    });
  });
});
