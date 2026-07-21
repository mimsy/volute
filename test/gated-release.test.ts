import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

function routesPath(name: string): string {
  return resolve(process.env.VOLUTE_HOME!, "minds", name, "home/.config/routes.json");
}

function writeRoutes(name: string, config: RoutingConfig | object): void {
  mkdirSync(resolve(process.env.VOLUTE_HOME!, "minds", name, "home/.config"), { recursive: true });
  writeFileSync(routesPath(name), JSON.stringify(config));
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

    it("renders the channel_invite prompt's platform/participant details block", async () => {
      const name = createMind({ rules: [] });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      const invites: string[] = [];
      manager.setNotifier(async (_mind, text) => {
        if (text.includes("[New channel:")) invites.push(text);
      });

      // A gated message carrying platform + participantCount exercises the `details`
      // branch of the getPrompt("channel_invite", …) rendering (#420 item 4).
      await manager.routeAndDeliver(name, {
        channel: "discord:general",
        sender: "alice",
        content: "hello",
        platform: "discord",
        participantCount: 3,
      });

      assert.equal(invites.length, 1, "one invite fired");
      assert.ok(invites[0].includes("Platform: discord"), "renders the Platform line");
      assert.ok(invites[0].includes("Participants: 3"), "renders the Participants line");
      assert.ok(invites[0].includes("Preview: hello"), "still renders the preview after details");
      // Every command the invite names must be a real one — this prompt is the mind's only
      // instruction on what to do about a held channel, so a stale command strands it.
      assert.ok(
        invites[0].includes('volute chat channels accept "discord:general"'),
        "renders the real accept command",
      );
      assert.ok(
        invites[0].includes('volute chat channels peek "discord:general"'),
        "renders the real peek command",
      );
      assert.ok(
        invites[0].includes('volute chat channels decline "discord:general"'),
        "renders the real decline command",
      );
      // `chat read` cannot show gated messages (they have no conversation) — the old invite
      // pointed there and left minds with no way to see what was held.
      assert.ok(
        !invites[0].includes("volute chat read"),
        "does not point at chat read, which cannot reach held messages",
      );
    });

    // BUG 3. The invite is the mind's only instruction on what to do about a held channel,
    // and minds paste it verbatim. An unquoted `#garden` is a comment to the shell: the arg
    // is stripped and the command dies with "Missing required argument". Observed live —
    // the mind concluded the `#` itself was the problem and dropped it, which is BUG 4.
    it("quotes the channel so the commands survive a shell", async () => {
      const name = createMind({ rules: [] });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;
      const invites: string[] = [];
      manager.setNotifier(async (_mind, text) => {
        if (text.startsWith("[New channel:")) invites.push(text);
      });

      await gate(manager, name, "#garden");

      assert.equal(invites.length, 1, "one invite fired");
      for (const verb of ["peek", "accept", "decline"]) {
        assert.ok(
          invites[0].includes(`volute chat channels ${verb} "#garden"`),
          `${verb} names the channel quoted`,
        );
        assert.ok(
          !new RegExp(`volute chat channels ${verb} #garden`).test(invites[0]),
          `${verb} never names the channel bare — the shell would eat it`,
        );
      }
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
      const name = createMind({ rules: [{ channel: "web", thread: "web" }], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      await gate(manager, name, "discord:general");
      const before = await rows(name);
      assert.equal(before[0].thread, "main", "gated at the fallback session");
      assert.equal(before[0].status, "gated");

      // Add a rule mapping the channel to a distinct session, then release.
      writeRoutes(name, {
        rules: [
          { channel: "web", thread: "web" },
          { channel: "discord:*", thread: "discord-inbox" },
        ],
        default: "main",
      });
      await manager.releaseGated(name);

      const after = await rows(name);
      const row = after.find((r) => r.channel === "discord:general");
      assert.ok(row);
      assert.equal(row.status, "pending", "promoted to pending");
      assert.equal(row.thread, "discord-inbox", "session rewritten to the current route");
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
        rules: [{ channel: "discord:*", thread: "inbox" }],
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

    it("a declined channel never produces an inbound row, even after a rule later matches (#420)", async () => {
      const name = createMind({ rules: [] });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      await manager.declineChannel(name, "discord:spam");
      for (let i = 0; i < 3; i++) await gate(manager, name, "discord:spam", `spam ${i}`);

      // Add a rule that WOULD match, then release. Declined channels are skipped, so the
      // rows stay archived and no inbound history is ever written for them.
      writeRoutes(name, {
        rules: [{ channel: "discord:*", thread: "inbox" }],
        default: "main",
      });
      await manager.releaseGated(name);

      const spamRows = (await rows(name)).filter((r) => r.channel === "discord:spam");
      assert.equal(
        spamRows.filter((r) => r.status === "pending").length,
        0,
        "declined channel is not promoted on release",
      );
      const db = await getDb();
      const inbound = await db
        .select()
        .from(mindHistory)
        .where(and(eq(mindHistory.mind, name), eq(mindHistory.type, "inbound")));
      assert.equal(inbound.length, 0, "a declined channel writes no inbound history");
    });

    it("expands a $new route to a generated session on release, not the literal '$new'", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      await gate(manager, name, "discord:general");

      writeRoutes(name, {
        rules: [{ channel: "discord:*", thread: "$new" }],
        default: "main",
      });
      await manager.releaseGated(name);

      const after = await rows(name);
      const row = after.find((r) => r.channel === "discord:general");
      assert.ok(row);
      assert.equal(row.status, "pending", "promoted to pending");
      assert.notEqual(row.thread, "$new", "the literal '$new' is never persisted");
      assert.match(row.thread, /^new-/, "session expanded to a generated ephemeral name");
    });

    it("promotes at most N per channel (newest) and archives the remainder with one summary", async () => {
      const name = createMind({ rules: [{ channel: "web", thread: "web" }], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      // 25 gated messages on one channel.
      for (let i = 0; i < 25; i++) await gate(manager, name, "discord:general", `msg ${i}`);
      m.notes.length = 0;

      writeRoutes(name, {
        rules: [
          { channel: "web", thread: "web" },
          { channel: "discord:*", thread: "discord" },
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
      // The summary must point somewhere that actually shows the archived 15.
      assert.ok(
        summaries[0].text.includes('volute chat channels peek "discord:general"'),
        "points at peek for the truncated remainder",
      );
      assert.ok(!summaries[0].text.includes("volute chat read"), "does not point at chat read");

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

      writeRoutes(name, { rules: [{ channel: "discord:*", thread: "discord" }], default: "main" });
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

      writeRoutes(name, { rules: [{ channel: "discord:*", thread: "discord" }], default: "main" });
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
      writeRoutes(name, { rules: [{ channel: "slack:*", thread: "slack" }], default: "main" });
      await manager.releaseGated(name);

      const after = await rows(name);
      assert.equal(after.filter((r) => r.status === "gated").length, 1, "still held");
      assert.equal(after.filter((r) => r.status === "pending").length, 0);
    });
  });

  describe("release serialization", () => {
    it("records each released message exactly once under concurrent releases", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      for (let i = 0; i < 5; i++) await gate(manager, name, "discord:general", `msg ${i}`);
      writeRoutes(name, { rules: [{ channel: "discord:*", thread: "discord" }], default: "main" });

      // Two releases racing: both read the gated rows before either promotes, so without
      // serialization each writes its own inbound history row for the same message. The
      // promote UPDATE is idempotent; the INSERT is not.
      await Promise.all([manager.releaseGated(name), manager.releaseGated(name)]);

      const db = await getDb();
      const inbound = await db
        .select()
        .from(mindHistory)
        .where(and(eq(mindHistory.mind, name), eq(mindHistory.type, "inbound")));
      assert.equal(inbound.length, 5, "no duplicate inbound rows from overlapping releases");
    });
  });

  describe("acceptChannel", () => {
    it("adds the rule, releases the backlog, and reports the count", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      for (let i = 0; i < 3; i++) await gate(manager, name, "discord:general", `msg ${i}`);

      const result = await manager.acceptChannel(name, "discord:general");
      assert.equal(result.ruleAdded, true);
      assert.equal(result.released, 3, "reports what it actually released");
      assert.equal(result.archived, 0);

      const after = await rows(name);
      assert.equal(after.filter((r) => r.status === "pending").length, 3, "backlog released");

      // The rule must land in the file the router reads, or the next message re-gates.
      const written = JSON.parse(readFileSync(routesPath(name), "utf-8")) as RoutingConfig;
      assert.deepEqual(written.rules, [{ channel: "discord:general", thread: "${channel}" }]);
    });

    it("routes to an explicit thread when given one", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      await gate(manager, name, "mail:noreply@github.com");
      const result = await manager.acceptChannel(name, "mail:noreply@github.com", "mail");
      assert.equal(result.thread, "mail");

      const row = (await rows(name)).find((r) => r.channel === "mail:noreply@github.com");
      assert.equal(row?.status, "pending");
      assert.equal(row?.thread, "mail", "released into the requested thread");
    });

    it("adds the rule even with nothing held, so future messages route", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      const result = await manager.acceptChannel(name, "discord:quiet", "quiet");
      assert.equal(result.ruleAdded, true);
      assert.equal(result.released, 0);

      const outcome = await gate(manager, name, "discord:quiet");
      assert.equal(outcome.routed && outcome.mode, "immediate", "no longer gated");
    });

    // BUG 4. Pushed by the unquoted invite (BUG 3) into dropping the `#`, a mind accepted
    // `garden` while the real slug was `#garden`. That appended a permanent rule matching
    // nothing, released 0 of the held messages, and exited 0 reporting success — leaving
    // the mind with a channel it could send to but would never hear from, and no reason to
    // doubt it. Refusing with the real slug is the whole point.
    it("refuses a near-miss channel name instead of writing a rule that never matches", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      for (let i = 0; i < 2; i++) await gate(manager, name, "#garden");

      await assert.rejects(
        () => manager!.acceptChannel(name, "garden"),
        /did you mean "#garden"/,
        "names the slug the mind actually meant",
      );

      const written = JSON.parse(readFileSync(routesPath(name), "utf-8")) as RoutingConfig;
      assert.deepEqual(written.rules, [], "no junk rule left behind");
      const after = await rows(name);
      assert.equal(after.filter((r) => r.status === "gated").length, 2, "backlog still held");

      // And the correct form still works, releasing what was held.
      const ok = await manager.acceptChannel(name, "#garden");
      assert.equal(ok.released, 2, "the quoted form releases the backlog");
    });

    it("flags an unrecognized channel rather than implying a join", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      // Nothing held, nothing by this name anywhere. Pre-routing is legitimate, so this is
      // allowed — but `known: false` is what stops the CLI printing a bare success line.
      const result = await manager.acceptChannel(name, "totally-made-up-channel");
      assert.equal(result.known, false, "reports that nothing by this name is known");
      assert.equal(result.released, 0);

      // A channel it has actually heard from is known, so no caveat is printed.
      await gate(manager, name, "discord:general");
      const real = await manager.acceptChannel(name, "discord:general");
      assert.equal(real.known, true, "a channel with queue rows is recognized");
    });

    it("refuses a near-miss on decline too", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      await gate(manager, name, "#garden");
      await assert.rejects(() => manager!.declineChannel(name, "garden"), /did you mean "#garden"/);

      const db = await getDb();
      const gateRows = await db.select().from(channelGates).where(eq(channelGates.mind, name));
      assert.equal(gateRows.length, 0, "no opt-out recorded against a name nothing sends from");
    });

    it("un-declines a channel so accepting after declining works", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      await gate(manager, name, "discord:general");
      await manager.declineChannel(name, "discord:general");
      await manager.acceptChannel(name, "discord:general", "discord");

      const db = await getDb();
      const gateRows = await db
        .select()
        .from(channelGates)
        .where(and(eq(channelGates.mind, name), eq(channelGates.channel, "discord:general")));
      assert.equal(gateRows.length, 0, "the decline is cleared");

      // A declined channel archives on arrival; after accepting, messages must flow again.
      const outcome = await gate(manager, name, "discord:general");
      assert.equal(outcome.routed && outcome.mode, "immediate");
    });

    it("is idempotent — a second accept adds no duplicate rule", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      await manager.acceptChannel(name, "discord:general", "discord");
      const second = await manager.acceptChannel(name, "discord:general", "discord");
      assert.equal(second.ruleAdded, false, "reports the rule already existed");
      assert.equal(second.thread, "discord");

      const written = JSON.parse(readFileSync(routesPath(name), "utf-8")) as RoutingConfig;
      assert.equal(written.rules?.length, 1, "no duplicate rule");
    });

    it("appends, preserving existing rule order", async () => {
      const name = createMind({
        rules: [
          { channel: "web", thread: "web" },
          { channel: "#*", thread: "${channel}" },
        ],
        default: "main",
      });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      await manager.acceptChannel(name, "discord:general", "discord");

      const written = JSON.parse(readFileSync(routesPath(name), "utf-8")) as RoutingConfig;
      assert.deepEqual(written.rules, [
        { channel: "web", thread: "web" },
        { channel: "#*", thread: "${channel}" },
        { channel: "discord:general", thread: "discord" },
      ]);
    });

    it("does not append a rule that an existing broader rule would shadow", async () => {
      // The docs tell minds that accept is idempotent and safe to run after hand-editing.
      // A wildcard rule already covering the channel means an appended exact rule would sit
      // where it can never match — so accept must report the thread that actually applies,
      // not the one that was asked for.
      const name = createMind({
        rules: [{ channel: "discord:*", thread: "chat" }],
        default: "main",
      });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      const result = await manager.acceptChannel(name, "discord:general", "somewhere-else");
      assert.equal(result.ruleAdded, false, "already routed — nothing to add");
      assert.equal(result.thread, "chat", "reports where messages actually land");

      const written = JSON.parse(readFileSync(routesPath(name), "utf-8")) as RoutingConfig;
      assert.equal(written.rules?.length, 1, "no shadowed rule appended");
    });

    it("reports the resolved thread, expanding ${channel}", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      const result = await manager.acceptChannel(name, "discord:general");
      assert.equal(result.thread, "discord:general", "not the literal '${channel}'");
    });

    it("counts only the accepted channel's messages, not the whole mind's", async () => {
      // The release is mind-wide by design (accepting one channel must not strand another
      // a rule already covers), so the counts must be scoped separately or they over-report.
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      for (let i = 0; i < 2; i++) await gate(manager, name, "discord:general");
      for (let i = 0; i < 3; i++) await gate(manager, name, "slack:general");
      // A rule covering the *other* channel, so its backlog also releases in the same run.
      writeRoutes(name, { rules: [{ channel: "slack:*", thread: "slack" }], default: "main" });

      const result = await manager.acceptChannel(name, "discord:general", "discord");
      assert.equal(result.released, 2, "counts discord's 2, not all 5");
    });

    it("refuses an array-form routes.json instead of silently dropping the rule", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      // Valid JSON, wrong shape. A top-level array has no `rules`, so such a mind gates
      // everything — precisely the case accept exists for. Setting `.rules` on an array
      // and stringifying drops it, which would report success having changed nothing.
      const arrayForm = JSON.stringify([{ channel: "web", thread: "web" }]);
      writeFileSync(routesPath(name), arrayForm);

      await assert.rejects(() => manager!.acceptChannel(name, "discord:general"), /malformed/);
      assert.equal(readFileSync(routesPath(name), "utf-8"), arrayForm, "file left untouched");
    });

    it("does not lose a rule when two accepts run concurrently", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      // Both would read the same config and the second write would drop the first's rule.
      await Promise.all([
        manager.acceptChannel(name, "discord:a", "a"),
        manager.acceptChannel(name, "discord:b", "b"),
      ]);

      const written = JSON.parse(readFileSync(routesPath(name), "utf-8")) as RoutingConfig;
      assert.deepEqual(
        written.rules?.map((r) => r.channel).sort(),
        ["discord:a", "discord:b"],
        "both rules survive",
      );
    });

    it("refuses to touch a malformed routes.json", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      // routes.json is a mind-owned file — overwriting a broken one would destroy routing
      // the mind wrote by hand, which is worse than failing loudly.
      const broken = '{ "rules": [ }';
      writeFileSync(routesPath(name), broken);

      await assert.rejects(
        () => manager!.acceptChannel(name, "discord:general"),
        /malformed/,
        "rejects rather than clobbering",
      );
      assert.equal(readFileSync(routesPath(name), "utf-8"), broken, "file left untouched");
    });
  });

  describe("peekChannel", () => {
    // Peek doesn't refuse — reading is harmless and an empty backlog is a real answer —
    // but "No held messages on garden" is a confident all-clear to a mind that meant
    // "#garden" and has two messages waiting. That is how BUG 3 became BUG 4.
    it("suggests the real slug rather than reporting an empty backlog", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      for (let i = 0; i < 2; i++) await gate(manager, name, "#garden");

      const miss = await manager.peekChannel(name, "garden");
      assert.equal(miss.count, 0);
      assert.equal(miss.suggestion, "#garden", "points at the channel that actually holds them");

      const hit = await manager.peekChannel(name, "#garden");
      assert.equal(hit.count, 2);
      assert.equal(hit.suggestion, undefined, "no caveat when the name was right");
    });

    it("returns held messages oldest-first without changing anything", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      for (let i = 0; i < 3; i++) await gate(manager, name, "discord:general", `msg ${i}`);

      const peeked = await manager.peekChannel(name, "discord:general");
      assert.equal(peeked.count, 3);
      assert.deepEqual(
        peeked.messages.map((p) => p.content),
        ["msg 0", "msg 1", "msg 2"],
      );
      assert.equal(peeked.messages[0].sender, "alice");
      assert.equal(peeked.messages[0].status, "gated");

      const after = await rows(name);
      assert.equal(after.filter((r) => r.status === "gated").length, 3, "peek changes no state");
    });

    it("still shows a declined channel's archived backlog", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      for (let i = 0; i < 2; i++) await gate(manager, name, "discord:spam", `spam ${i}`);
      await manager.declineChannel(name, "discord:spam");

      const peeked = await manager.peekChannel(name, "discord:spam");
      assert.equal(peeked.count, 2, "archived messages stay readable");
      assert.ok(peeked.messages.every((p) => p.status === "archived"));
    });

    it("caps how much it returns but reports the true total", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      for (let i = 0; i < 55; i++) await gate(manager, name, "discord:flood", `msg ${i}`);

      const peeked = await manager.peekChannel(name, "discord:flood");
      assert.equal(peeked.count, 55, "reports the real backlog size");
      assert.equal(peeked.shown, 50, "returns at most the cap");
      assert.equal(peeked.messages[0].content, "msg 5", "keeps the most recent window");
      assert.equal(peeked.messages.at(-1)?.content, "msg 54");
    });

    it("returns an empty result for a channel with nothing held", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      const peeked = await manager.peekChannel(name, "discord:nothing");
      assert.equal(peeked.count, 0);
      assert.deepEqual(peeked.messages, []);
    });
  });

  describe("releaseGatedSweep", () => {
    it("releases messages held by routes.json edits made while the daemon was down", async () => {
      const a = createMind({ rules: [], default: "main" });
      const b = createMind({ rules: [], default: "main" });
      cleanup.push(a, b);
      const m = makeManager();
      manager = m.manager;

      await gate(manager, a, "discord:general", "for a");
      await gate(manager, b, "slack:general", "for b");

      // Edit both configs with the change listener inert — exactly what a daemon that was
      // down sees at boot: matching rules on disk, messages still held.
      writeRoutes(a, { rules: [{ channel: "discord:*", thread: "discord" }], default: "main" });
      writeRoutes(b, { rules: [{ channel: "slack:*", thread: "slack" }], default: "main" });

      const stillGated = async (n: string) =>
        (await rows(n)).filter((r) => r.status === "gated").length;
      assert.equal(await stillGated(a), 1, "editing the file alone releases nothing");
      assert.equal(await stillGated(b), 1);

      await manager.releaseGatedSweep();

      assert.equal(await stillGated(a), 0, "sweep released the first mind");
      assert.equal(await stillGated(b), 0, "sweep released the second mind");
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
