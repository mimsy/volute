import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  DeliveryManager,
  formatSuggestions,
  queuedPayload,
  withHeldPreface,
} from "../packages/daemon/src/lib/delivery/delivery-manager.js";
import {
  clearConfigCache,
  type RoutingConfig,
  setRoutesChangeListener,
} from "../packages/daemon/src/lib/delivery/delivery-router.js";
import { createChannel } from "../packages/daemon/src/lib/events/conversations.js";
import { upsertEventRule } from "../packages/daemon/src/lib/mind/event-routes.js";
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

    it("keeps a former file-destination rule's channel held rather than discarding it", async () => {
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
      assert.equal(after.filter((r) => r.status === "gated").length, 1, "still held, not lost");
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

    // Delivered queue rows are *deleted*, so a channel the mind has been using
    // successfully has no queue rows left — and an external-platform channel is in no
    // other table. Keyed only off the queue, the healthier the channel the more likely
    // we'd call it unrecognized, which inverts the whole point of the flag.
    it("still recognizes a channel whose queue rows are gone but history remains", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      const db = await getDb();
      await db.insert(mindHistory).values({
        mind: name,
        type: "inbound",
        channel: "discord:general",
        content: "an established conversation",
      });

      const result = await manager.acceptChannel(name, "discord:general");
      assert.equal(result.known, true, "a channel in history is recognized without queue rows");
    });

    // `normalizeChannelKey` strips the sigil, so a bare `alice` matches both the DM
    // `@alice` and the channel `#alice`. Naming only the first would mean picking by ASCII
    // order (`#` is 0x23, `@` is 0x40) and presenting that accident as an answer — a
    // confident reply to an open question, which is the failure this PR exists to remove.
    it("names every near-miss when a bare name is ambiguous", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      const who = `amb-${Math.random().toString(36).slice(2, 8)}`;
      // A DM with them in history, and a public channel of the same name.
      const db = await getDb();
      await db.insert(mindHistory).values({
        mind: name,
        type: "inbound",
        channel: `@${who}`,
        content: "a direct message",
      });
      await createChannel(who);

      await assert.rejects(
        () => manager!.acceptChannel(name, who),
        (err: Error) => {
          assert.ok(err.message.includes(`"#${who}"`), "names the channel");
          assert.ok(err.message.includes(`"@${who}"`), "names the DM too");
          assert.match(err.message, /did you mean "[^"]+" or "[^"]+"\?/, "reads as a real choice");
          return true;
        },
      );
    });

    it("phrases one suggestion as a plain question and several as a choice", () => {
      // The common case is a single near-miss and must not read like a list of one.
      assert.equal(formatSuggestions(["#garden"]), '"#garden"');
      assert.equal(formatSuggestions(["#alice", "@alice"]), '"#alice" or "@alice"');
      assert.equal(formatSuggestions(["#a", "#b", "@c"]), '"#a", "#b", or "@c"');
    });

    // The suggestion set is echoed back to the mind, so anything in it is something the
    // mind can learn the exact slug of by guessing a nearby name. Minds are untrusted
    // principals; a private channel's existence must not be confirmable that way.
    it("suggests a public channel but never a private one", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      const pub = `pub-${Math.random().toString(36).slice(2, 8)}`;
      const priv = `priv-${Math.random().toString(36).slice(2, 8)}`;
      await createChannel(pub);
      await createChannel(priv, undefined, { private: true });

      // Near-miss on a public channel: the mind is told the real slug.
      const pubMiss = await manager.peekChannel(name, pub.toUpperCase());
      assert.deepEqual(pubMiss.suggestions, [`#${pub}`], "public channel is suggested");

      // Near-miss on a private one: no suggestion, so its slug stays unconfirmed.
      const privMiss = await manager.peekChannel(name, priv.toUpperCase());
      assert.equal(privMiss.suggestions, undefined, "private channel is never suggested");
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

    it("does not lose an event rule written while an accept is in flight (#1261)", async () => {
      // accept's read and its replace must be one step: an upsertEventRule landing between
      // them would otherwise be overwritten by accept's stale copy. Start the upsert the
      // moment accept opens routes.json to read it — inside that window, whatever the load.
      manager = makeManager().manager;
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const dir = resolve(process.env.VOLUTE_HOME!, "minds", name);
      const fsp = createRequire(import.meta.url)("node:fs/promises");
      const open = fsp.open;
      let upsert: Promise<boolean> | undefined;
      const opened = mock.method(fsp, "open", (path: string, flags: number, mode: number) => {
        const reading = (flags & fsConstants.O_ACCMODE) === fsConstants.O_RDONLY;
        if (!upsert && reading && String(path).endsWith("routes.json")) {
          upsert = upsertEventRule(dir, "schedule:dream", "dreams", { owner: null, name });
        }
        return open(path, flags, mode);
      });
      syncBuiltinESMExports();
      try {
        await manager.acceptChannel(name, "discord:general", "discord");
        assert.ok(upsert, "the upsert started inside the accept");
        await upsert;
      } finally {
        opened.mock.restore();
        syncBuiltinESMExports();
      }

      const written = JSON.parse(readFileSync(routesPath(name), "utf-8")) as RoutingConfig;
      assert.ok(
        written.rules?.some((r) => r.event === "schedule:dream"),
        "event rule survives",
      );
      assert.ok(
        written.rules?.some((r) => r.channel === "discord:general"),
        "accept rule too",
      );
    });

    it("treats an empty routes.json as no routing yet, as the router does", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      manager = makeManager().manager;
      writeFileSync(routesPath(name), "  \n");

      const result = await manager.acceptChannel(name, "discord:general", "discord");
      assert.equal(result.ruleAdded, true);
      const written = JSON.parse(readFileSync(routesPath(name), "utf-8")) as RoutingConfig;
      assert.deepEqual(written.rules, [{ channel: "discord:general", thread: "discord" }]);
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

    // The mind owns routes.json and the daemon may be root (#1167): a link it planted
    // there or at .config/ must refuse rather than aim the daemon's read or write.
    it("refuses a routes.json the mind swapped for a symlink, leaving the target alone", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      manager = makeManager().manager;
      const outside = resolve(routesPath(name), "../../../outside.json");
      writeFileSync(outside, '{"rules":[]}');
      rmSync(routesPath(name));
      symlinkSync(outside, routesPath(name));

      await assert.rejects(() => manager!.acceptChannel(name, "discord:general"), /unreadable/);
      assert.equal(readFileSync(outside, "utf-8"), '{"rules":[]}', "target untouched");
      assert.ok(lstatSync(routesPath(name)).isSymbolicLink(), "link left for the mind");
    });

    it("refuses a .config/ linked out of the mind, writing nothing there", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      manager = makeManager().manager;
      const elsewhere = mkdtempSync(resolve(tmpdir(), "routes-elsewhere-"));
      try {
        const config = resolve(routesPath(name), "..");
        rmSync(config, { recursive: true });
        symlinkSync(elsewhere, config);
        await assert.rejects(() => manager!.acceptChannel(name, "discord:general"));
        assert.deepEqual(readdirSync(elsewhere), []);
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    it("refuses a FIFO at routes.json instead of hanging", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      manager = makeManager().manager;
      rmSync(routesPath(name));
      await promisify(execFile)("mkfifo", [routesPath(name)]);
      const outcome = await Promise.race([
        manager.acceptChannel(name, "discord:general").then(
          () => "accepted",
          () => "refused",
        ),
        new Promise((r) => setTimeout(() => r("hung"), 5000).unref()),
      ]);
      assert.equal(outcome, "refused");
    });

    it("creates routes.json by replacing, leaving no temp file behind", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      manager = makeManager().manager;
      rmSync(routesPath(name));
      await manager.acceptChannel(name, "discord:general", "discord");
      const written = JSON.parse(readFileSync(routesPath(name), "utf-8")) as RoutingConfig;
      assert.equal(written.rules?.[0]?.channel, "discord:general");
      assert.deepEqual(
        readdirSync(resolve(routesPath(name), "..")).filter((f) => f.endsWith(".tmp")),
        [],
      );
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
      assert.deepEqual(
        miss.suggestions,
        ["#garden"],
        "points at the channel that actually holds them",
      );

      const hit = await manager.peekChannel(name, "#garden");
      assert.equal(hit.count, 2);
      assert.equal(hit.suggestions, undefined, "no caveat when the name was right");
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

  describe("peeked messages arrive prefaced (#1172)", () => {
    const reader = (name: string, thread = "main") => ({ name, thread });
    const wireContent = (row: typeof deliveryQueue.$inferSelect) =>
      withHeldPreface(queuedPayload(row)).content;

    it("stamps the rows the mind was shown with its latest peek", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      await gate(manager, name, "@claude", "hello");
      await manager.peekChannel(name, "@claude"); // a host on the dashboard
      assert.equal((await rows(name))[0].peeked_at, null, "a host's peek isn't the mind's");

      await manager.peekChannel(name, "@claude", reader(name));
      await manager.peekChannel(name, "@claude", reader(name, "other"));
      const [row] = await rows(name);
      assert.ok(row.peeked_at);
      assert.equal(row.peeked_thread, "other", "the latest peek overwrites");
      assert.equal(row.status, "gated", "peeking changes nothing about delivery");
    });

    it("stamps only the rows addressed to the reader — a variant's, or the parent's", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const variant = `${name}-exp`;
      const m = makeManager();
      manager = m.manager;

      await gate(manager, name, "@claude", "to the parent");
      await gate(manager, name, "@claude", "to the variant");
      const db = await getDb();
      const [, toVariant] = (await rows(name)).sort((x, y) => x.id - y.id);
      await db
        .update(deliveryQueue)
        .set({ target_mind: variant })
        .where(eq(deliveryQueue.id, toVariant.id));

      await manager.peekChannel(name, "@claude", reader(variant, "v-main"));
      let [p, v] = (await rows(name)).sort((x, y) => x.id - y.id);
      assert.equal(p.peeked_at, null, "a variant's peek isn't the parent having looked");
      assert.equal(v.peeked_thread, "v-main");

      await manager.peekChannel(name, "@claude", reader(name, "main"));
      [p, v] = (await rows(name)).sort((x, y) => x.id - y.id);
      assert.equal(p.peeked_thread, "main");
      assert.equal(v.peeked_thread, "v-main", "nor the parent's the variant having looked");
    });

    it("delivers a peeked message prefaced, and an unpeeked one as it was", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      await gate(manager, name, "@claude", "are you there?");
      await manager.peekChannel(name, "@claude", reader(name));
      await gate(manager, name, "@claude", "one more thing"); // arrives after the peek

      const result = await manager.acceptChannel(name, "@claude");
      assert.equal(result.released, 2, "both are delivered — nothing is held back");

      const [peeked, fresh] = (await rows(name)).sort((a, b) => a.id - b.id);
      assert.match(
        String(wireContent(peeked)),
        /^\[peeked — you peeked this from thread "main" at \d{4}-\d{2}-\d{2} \d{2}:\d{2}\.\]\nare you there\?$/,
      );
      assert.equal(
        "peeked" in withHeldPreface(queuedPayload(peeked)),
        false,
        "the marker never reaches the mind as a raw field",
      );
      assert.equal(wireContent(fresh), "one more thing", "never peeked, so as it was");
      assert.equal(JSON.parse(peeked.payload).peeked, undefined, "nothing written into payloads");

      const db = await getDb();
      const inbound = await db
        .select()
        .from(mindHistory)
        .where(and(eq(mindHistory.mind, name), eq(mindHistory.type, "inbound")));
      assert.ok(
        inbound.some((r) => r.content === "are you there?"),
        "history keeps what the sender actually wrote",
      );
    });

    it("prefaces a message peeked after its release promoted it, if not yet delivered", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      await gate(manager, name, "@claude", "hi");
      writeRoutes(name, { rules: [{ channel: "@claude", thread: "claude" }], default: "main" });
      // The peek has read the row as gated (and will show it); the release commits before
      // the stamp is written. The mind isn't running, so nothing has been delivered yet —
      // a delivery that had already read the row would go out unprefaced (a known limit).
      const db = await getDb();
      const update = db.update;
      db.update = ((...args: Parameters<typeof update>) => {
        db.update = update;
        const released = manager!.releaseGated(name);
        const builder = update.apply(db, args);
        const set = builder.set.bind(builder);
        builder.set = ((values: never) => {
          const where = set(values);
          const run = where.where.bind(where);
          where.where = ((cond: never) => {
            const q = run(cond);
            return released.then(() => q);
          }) as never;
          return where;
        }) as never;
        return builder;
      }) as typeof db.update;
      try {
        const peeked = await manager.peekChannel(name, "@claude", reader(name));
        assert.equal(peeked.messages[0].content, "hi", "the mind was shown it");
      } finally {
        db.update = update;
      }

      const [row] = await rows(name);
      assert.equal(row.status, "pending", "the release got there first");
      assert.match(String(wireContent(row)), /^\[peeked — /, "and it still says it was seen");
    });

    it("keeps the peek out of payloads a hold writes back, and still prefaces", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      await gate(manager, name, "@claude", "hi");
      await manager.peekChannel(name, "@claude", reader(name));
      // A spend hold parks the released row, writing its payload back to the queue.
      manager.setHoldCheck(() => ({ reason: "spend", scope: "mind" }));
      manager.setRunningCheck(() => true);
      await manager.acceptChannel(name, "@claude");

      const [row] = await rows(name);
      assert.equal(row.status, "held");
      const stored = JSON.parse(row.payload);
      assert.ok(stored.held, "the hold did write the payload back");
      assert.equal(stored.peeked, undefined, "the columns stay the one source");
      assert.match(String(wireContent(row)), /\[peeked — you peeked this from thread "main"/);
    });

    it("prefaces block content with a leading text block", () => {
      const wire = withHeldPreface({
        channel: "@claude",
        sender: "a",
        senderId: null,
        content: [
          { type: "text", text: "hi" },
          { type: "text", text: "there" },
        ],
        peeked: { thread: "main", at: Date.now() },
      });
      const blocks = wire.content as { type: string; text?: string }[];
      assert.equal(blocks.length, 3);
      assert.match(blocks[0].text!, /^\[peeked — you peeked this from thread "main" at /);
    });

    it("never marks a message with parts a peek couldn't show", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      await manager.routeAndDeliver(name, {
        channel: "@claude",
        sender: "alice",
        content: [
          { type: "text", text: "look" },
          { type: "image", media_type: "image/png", data: "iVBORw0KGgo=" },
        ],
      });
      await manager.peekChannel(name, "@claude", reader(name));
      assert.equal((await rows(name))[0].peeked_at, null, "the image was never shown");
    });

    it("a failed stamp still returns what was held", async () => {
      const name = createMind({ rules: [], default: "main" });
      cleanup.push(name);
      const m = makeManager();
      manager = m.manager;

      await gate(manager, name, "@claude", "hi");
      const db = await getDb();
      const update = db.update;
      db.update = (() => {
        throw new Error("disk full");
      }) as typeof db.update;
      try {
        const peeked = await manager.peekChannel(name, "@claude", reader(name));
        assert.equal(peeked.messages[0].content, "hi");
      } finally {
        db.update = update;
      }
      assert.equal((await rows(name))[0].peeked_at, null);
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
