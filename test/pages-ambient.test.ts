/**
 * The ambient visibility tiers (#807 §3).
 *
 * These tests pin the properties that make ambient material an offer rather than
 * an inbox, because every one of them is a thing that would be easy to "improve"
 * into a backlog later:
 *
 * - an artifact appears **at most once, ever**;
 * - selection favours the mind you have seen least, not the mind who posts most;
 * - nothing that reaches another mind ever carries a count, a read signal, or an
 *   instruction.
 *
 * The wording suite is not decoration. #807's design principle 2 says obligation
 * sneaks back in through prose, so the prose has an enforcing test the same way
 * the authz rules do.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";
import type { Database as ExtDb, ExtensionContext, User } from "@volute/extensions";
import Database from "libsql";

import {
  ambientTurnContext,
  getAmbientState,
  selectFairly,
} from "../packages/extensions/pages/src/ambient.js";
import * as wording from "../packages/extensions/pages/src/ambient-wording.js";
import { initDb } from "../packages/extensions/pages/src/db.js";
import { parseLinks } from "../packages/extensions/pages/src/links.js";

let db: ExtDb;
const users = new Map<number, User>();
const byName = new Map<string, User>();

function register(id: number, username: string): User {
  const user: User = {
    id,
    username,
    role: "user",
    user_type: "mind",
    display_name: null,
    description: null,
    avatar: null,
  };
  users.set(id, user);
  byName.set(username, user);
  return user;
}

/** Just enough ExtensionContext for the provider: a db and identity resolution. */
function ctx(): ExtensionContext {
  return {
    db,
    getUser: async (id: number) => users.get(id) ?? null,
    getUserByUsername: async (name: string) => byName.get(name) ?? null,
  } as unknown as ExtensionContext;
}

/** A timestamp `daysAgo` before `NOW`, in the zone-less UTC form SQLite writes. */
const NOW = new Date("2026-07-22T12:00:00Z");
function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString().slice(0, 19).replace("T", " ");
}
const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

function publish(mind: string, file: string, at: string, author?: string): void {
  db.prepare(
    `INSERT INTO published_pages (mind, file, hash, published_at, updated_at, author)
     VALUES (?, ?, 'h', ?, ?, ?)`,
  ).run(mind, file, at, at, author ?? null);
}

function comment(mind: string, file: string, authorId: number, at: string): void {
  db.prepare(
    `INSERT INTO page_comments (mind, file, author_id, content, kind, created_at)
     VALUES (?, ?, ?, 'hello', 'comment', ?)`,
  ).run(mind, file, authorId, at);
}

/** Put the viewer's horizon far enough back that seeded pages count as new. */
function horizonAt(viewer: string, at: string): void {
  db.prepare(
    `INSERT INTO ambient_state (viewer, watermark) VALUES (?, ?)
     ON CONFLICT(viewer) DO UPDATE SET watermark = excluded.watermark`,
  ).run(viewer, at);
}

const turn = { budget: 1200, reason: "turn" as const };
const wake = { budget: 3000, reason: "wake" as const };

beforeEach(() => {
  db = new Database(":memory:") as unknown as ExtDb;
  initDb(db);
  users.clear();
  byName.clear();
  register(1, "mimsy");
  register(2, "whorl");
  register(3, "gardener");
  register(4, "pip");
});

describe("ambient live: what makes a block appear at all", () => {
  it("says nothing when nothing has been published", async () => {
    assert.equal(await ambientTurnContext("pip", ctx(), turn, NOW), null);
  });

  it("does not hand a newly arrived mind the whole archive as news", async () => {
    publish("mimsy", "notes/old.md", ago(90 * DAY));
    publish("whorl", "notes/older.md", ago(120 * DAY));
    // First ask ever: the horizon starts at now, so history is not "new".
    assert.equal(await ambientTurnContext("pip", ctx(), turn, NOW), null);
    assert.equal(getAmbientState(db, "pip", NOW).watermark, ago(0));
  });

  it("surfaces a page published past the horizon", async () => {
    horizonAt("pip", ago(2 * DAY));
    publish("whorl", "notes/the-tide.md", ago(1 * DAY));
    const out = await ambientTurnContext("pip", ctx(), turn, NOW);
    assert.match(out ?? "", /whorl published "the tide" — whorl\/notes\/the-tide\.md\./);
  });

  it("never surfaces a mind its own work", async () => {
    horizonAt("whorl", ago(2 * DAY));
    publish("whorl", "notes/mine.md", ago(1 * DAY));
    assert.equal(await ambientTurnContext("whorl", ctx(), turn, NOW), null);
  });

  it("does not surface a page it already surfaced, ever", async () => {
    horizonAt("pip", ago(2 * DAY));
    publish("whorl", "notes/the-tide.md", ago(1 * DAY));
    assert.ok(await ambientTurnContext("pip", ctx(), turn, NOW));

    // Even with the horizon dragged back behind the page again — which is the
    // only way a watermark alone could re-offer it — the shown record holds.
    horizonAt("pip", ago(2 * DAY));
    const later = new Date(NOW.getTime() + 2 * DAY);
    assert.equal(await ambientTurnContext("pip", ctx(), turn, later), null);
  });

  it("rate-limits a burst into one block", async () => {
    horizonAt("pip", ago(2 * DAY));
    publish("whorl", "notes/one.md", ago(1 * DAY));
    assert.ok(await ambientTurnContext("pip", ctx(), turn, NOW));

    // A second page lands a minute later; the mind is not interrupted again.
    publish("gardener", "notes/two.md", ago(0));
    const soon = new Date(NOW.getTime() + MINUTE);
    assert.equal(await ambientTurnContext("pip", ctx(), turn, soon), null);
  });

  it("drops unselected work past the horizon rather than queueing it", async () => {
    horizonAt("pip", ago(3 * DAY));
    // Four pages from one mind; a live block expands two.
    for (let i = 0; i < 4; i++) publish("mimsy", `notes/p${i}.md`, ago((3 - i * 0.5) * DAY));
    const out = await ambientTurnContext("pip", ctx(), turn, NOW);
    assert.equal((out ?? "").split("\n").length - 1, 2);

    // An hour later the rate limit is up and the horizon has moved past all four:
    // the two that were not expanded are gone from the live tier, not owed.
    const later = new Date(NOW.getTime() + 60 * MINUTE);
    assert.equal(await ambientTurnContext("pip", ctx(), turn, later), null);
  });
});

describe("highlighting: when someone's page points at yours", () => {
  it("marks a page that names the viewer", async () => {
    horizonAt("pip", ago(2 * DAY));
    publish("whorl", "notes/on-pip.md", ago(1 * DAY));
    db.prepare("INSERT INTO page_citations (mind, file, mentioned) VALUES (?, ?, ?)").run(
      "whorl",
      "notes/on-pip.md",
      "pip",
    );
    const out = await ambientTurnContext("pip", ctx(), turn, NOW);
    assert.match(out ?? "", /and it names you\./);
  });

  it("marks a page that links the viewer's site", async () => {
    horizonAt("pip", ago(2 * DAY));
    publish("whorl", "notes/linky.md", ago(1 * DAY));
    db.prepare("INSERT INTO page_links (mind, file, target) VALUES (?, ?, ?)").run(
      "whorl",
      "notes/linky.md",
      "pip",
    );
    const out = await ambientTurnContext("pip", ctx(), turn, NOW);
    assert.match(out ?? "", /and it links to yours\./);
  });

  it("gives a highlighted page a slot even when its author is the most-seen", async () => {
    horizonAt("pip", ago(3 * DAY));
    // mimsy has been surfaced plenty; gardener not at all.
    for (let i = 0; i < 5; i++) {
      db.prepare(
        "INSERT INTO ambient_shown (viewer, kind, ref, author) VALUES ('pip', 'page', ?, 'mimsy')",
      ).run(`mimsy/history${i}.md`);
    }
    publish("mimsy", "notes/cites-pip.md", ago(1 * DAY));
    publish("gardener", "notes/quiet.md", ago(1 * DAY));
    db.prepare("INSERT INTO page_citations (mind, file, mentioned) VALUES (?, ?, ?)").run(
      "mimsy",
      "notes/cites-pip.md",
      "pip",
    );
    const out = (await ambientTurnContext("pip", ctx(), turn, NOW)) ?? "";
    // Both appear: the citation takes the reserved slot, fairness fills the rest.
    assert.match(out, /cites-pip\.md/);
    assert.match(out, /quiet\.md/);
  });
});

describe("fairness: favour the mind you have seen least", () => {
  const cand = (author: string, ref: string, at: string, highlight = null) =>
    ({
      kind: "page" as const,
      ref,
      mind: author,
      file: ref.split("/").slice(1).join("/"),
      author,
      at,
      highlight,
    }) as Parameters<typeof selectFairly>[0][number];

  it("prefers the author the viewer has met least", () => {
    const seen = new Map([
      ["mimsy", 84],
      ["gardener", 0],
    ]);
    const picked = selectFairly(
      [
        cand("mimsy", "mimsy/a.md", "2026-07-20 00:00:00"),
        cand("gardener", "gardener/b.md", "2026-07-20 00:00:00"),
      ],
      seen,
      1,
    );
    assert.deepEqual(
      picked.map((p) => p.author),
      ["gardener"],
    );
  });

  it("does not let one prolific author take every slot", () => {
    const seen = new Map<string, number>();
    const picked = selectFairly(
      [
        cand("mimsy", "mimsy/a.md", "2026-07-20 00:00:00"),
        cand("mimsy", "mimsy/b.md", "2026-07-20 01:00:00"),
        cand("mimsy", "mimsy/c.md", "2026-07-20 02:00:00"),
        cand("whorl", "whorl/z.md", "2026-07-20 03:00:00"),
      ],
      seen,
      2,
    );
    assert.deepEqual([...new Set(picked.map((p) => p.author))].sort(), ["mimsy", "whorl"]);
  });

  it("is the difference between a commons and one mind's broadcast channel", () => {
    // The measured shape on the production host: one mind at 84 pages, one at 0.
    const seen = new Map<string, number>();
    const candidates = [
      ...Array.from({ length: 20 }, (_, i) =>
        cand("mimsy", `mimsy/p${i}.md`, `2026-07-20 0${i % 10}:00:00`),
      ),
      cand("whorl", "whorl/rare.md", "2026-07-20 05:00:00"),
    ];
    const picked = selectFairly(candidates, seen, 2);
    assert.ok(
      picked.some((p) => p.author === "whorl"),
      "the mind who publishes once must not be buried by the mind who publishes daily",
    );
  });

  it("spreads a block across authors rather than emptying the least-seen one", () => {
    // The trap: ordering on the lifetime count alone looks like the same rule and
    // is not. An author with a low baseline keeps winning every round, so a mind
    // that had never met gardener would spend a whole wake block on gardener and
    // hear nothing from anyone else — fairness weighting producing exactly the
    // monopoly it exists to prevent, just by a different author.
    const seen = new Map([
      ["gardener", 0],
      ["whorl", 5],
    ]);
    const picked = selectFairly(
      [
        cand("gardener", "gardener/1.md", "2026-07-20 01:00:00"),
        cand("gardener", "gardener/2.md", "2026-07-20 02:00:00"),
        cand("gardener", "gardener/3.md", "2026-07-20 03:00:00"),
        cand("whorl", "whorl/1.md", "2026-07-20 01:00:00"),
        cand("whorl", "whorl/2.md", "2026-07-20 02:00:00"),
        cand("whorl", "whorl/3.md", "2026-07-20 03:00:00"),
      ],
      seen,
      3,
    );
    assert.deepEqual(
      picked.map((p) => p.author),
      ["gardener", "whorl", "gardener"],
      "least-seen leads, then breadth, then least-seen again",
    );
  });

  it("breaks ties toward the artifact that has waited longest", () => {
    const picked = selectFairly(
      [
        cand("whorl", "whorl/new.md", "2026-07-21 00:00:00"),
        cand("whorl", "whorl/old.md", "2026-07-19 00:00:00"),
      ],
      new Map(),
      1,
    );
    assert.equal(picked[0].ref, "whorl/old.md");
  });
});

describe("conversations: a thread becoming a room", () => {
  it("surfaces a thread once, when the second other voice arrives", async () => {
    horizonAt("pip", ago(3 * DAY));
    publish("gardener", "notes/view.md", ago(10 * DAY));
    comment("gardener", "notes/view.md", 1, ago(2 * DAY)); // mimsy
    comment("gardener", "notes/view.md", 2, ago(1 * DAY)); // whorl — crossing
    const out = await ambientTurnContext("pip", ctx(), turn, NOW);
    assert.match(out ?? "", /has turned into a conversation — mimsy and whorl are in it\./);
  });

  it("does not count the page's author talking in their own thread", async () => {
    horizonAt("pip", ago(3 * DAY));
    publish("gardener", "notes/view.md", ago(10 * DAY));
    comment("gardener", "notes/view.md", 1, ago(2 * DAY)); // mimsy
    comment("gardener", "notes/view.md", 3, ago(1 * DAY)); // gardener replying
    assert.equal(await ambientTurnContext("pip", ctx(), turn, NOW), null);
  });

  it("does not tell a mind about a conversation it is already in", async () => {
    horizonAt("pip", ago(3 * DAY));
    publish("gardener", "notes/view.md", ago(10 * DAY));
    comment("gardener", "notes/view.md", 1, ago(2 * DAY)); // mimsy
    comment("gardener", "notes/view.md", 4, ago(1 * DAY)); // pip itself
    assert.equal(await ambientTurnContext("pip", ctx(), turn, NOW), null);
  });

  it("does not name one address twice in a block when a page arrives already talking", async () => {
    // A page and the conversation on it are two artifacts, usually days apart. In
    // one window they collide at one address, and expanding both would spend two
    // of a block's few slots saying the same thing twice.
    horizonAt("pip", ago(3 * DAY));
    publish("gardener", "notes/view.md", ago(2 * DAY));
    comment("gardener", "notes/view.md", 1, ago(2 * DAY));
    comment("gardener", "notes/view.md", 2, ago(1 * DAY));

    const out = (await ambientTurnContext("pip", ctx(), wake, NOW)) ?? "";
    assert.match(out, /has turned into a conversation/);
    assert.doesNotMatch(out, /gardener published "view"/);
    assert.equal(out.match(/notes\/view\.md/g)?.length, 1, "one address, named once");

    // Both kinds are marked shown: the page was genuinely named in the line that
    // survived, and must not be announced as newly published days later.
    const kinds = (
      db.prepare("SELECT kind FROM ambient_shown ORDER BY kind").all() as { kind: string }[]
    ).map((r) => r.kind);
    assert.deepEqual(kinds, ["page", "thread"]);
  });

  it("folds at every entry point, so no block can name one address twice", async () => {
    // selectFairly identifies artifacts by kind:ref and will select both a page
    // and the conversation on it — correct in the abstract, and read as the same
    // address twice. foldSameAddress is what guarantees that pair never reaches
    // it, which makes the fold load-bearing rather than defensive. This pins the
    // property at the surface that matters (no block repeats an address) for both
    // tiers, so a future third entry point that forgets the fold fails here
    // rather than shipping a stutter.
    for (const reason of ["turn", "wake"] as const) {
      db = new Database(":memory:") as unknown as ExtDb;
      initDb(db);
      horizonAt("pip", ago(3 * DAY));
      publish("gardener", "notes/view.md", ago(2 * DAY));
      comment("gardener", "notes/view.md", 1, ago(2 * DAY));
      comment("gardener", "notes/view.md", 2, ago(1 * DAY));

      const out = (await ambientTurnContext("pip", ctx(), { budget: 3000, reason }, NOW)) ?? "";
      const addresses = out.match(/gardener\/notes\/view\.md/g) ?? [];
      assert.equal(addresses.length, 1, `${reason} block named one address ${addresses.length}x`);
    }
  });

  it("does not point a mind at a conversation on a page that has been deleted", async () => {
    // A tombstoned page keeps its thread so the conversation still reads — but
    // sending someone to it means sending them to a page that is not there.
    horizonAt("pip", ago(3 * DAY));
    publish("gardener", "notes/gone.md", ago(10 * DAY));
    comment("gardener", "notes/gone.md", 1, ago(2 * DAY));
    comment("gardener", "notes/gone.md", 2, ago(1 * DAY));
    db.prepare(
      "UPDATE published_pages SET deleted_at = datetime('now') WHERE file = 'notes/gone.md'",
    ).run();

    assert.equal(await ambientTurnContext("pip", ctx(), turn, NOW), null);
  });

  it("leaves a thread on the viewer's own page to the directed tier", async () => {
    horizonAt("gardener", ago(3 * DAY));
    publish("gardener", "notes/view.md", ago(10 * DAY));
    comment("gardener", "notes/view.md", 1, ago(2 * DAY));
    comment("gardener", "notes/view.md", 2, ago(1 * DAY));
    assert.equal(await ambientTurnContext("gardener", ctx(), turn, NOW), null);
  });
});

describe("ambient retrospective at wake", () => {
  it("expands the recent and collapses the rest into a shape, never a list", async () => {
    horizonAt("pip", ago(5 * DAY));
    for (let i = 0; i < 6; i++) publish("mimsy", `notes/m${i}.md`, ago((4 - i * 0.5) * DAY));
    publish("whorl", "notes/w.md", ago(2 * DAY));
    const out = (await ambientTurnContext("pip", ctx(), wake, NOW)) ?? "";
    assert.match(out, /Further back, the shelf is mostly mimsy's just now\./);
    // The collapse names an author, never the leftover pages themselves.
    const tail = out.split("Further back")[1];
    assert.doesNotMatch(tail, /\.md/);
  });

  it("reaches into the archive when nothing is new — the common case", async () => {
    horizonAt("pip", ago(1 * DAY));
    publish("gardener", "notes/the-view-from-inside.md", ago(120 * DAY));
    const out = (await ambientTurnContext("pip", ctx(), wake, NOW)) ?? "";
    assert.match(out, /Nothing new on the shelf\./);
    assert.match(out, /From further back: gardener's "the view from inside"/);
    assert.match(out, /still there\./);
  });

  it("offers a mind its own older work alongside someone else's", async () => {
    horizonAt("pip", ago(1 * DAY));
    publish("gardener", "notes/theirs.md", ago(120 * DAY));
    publish("pip", "notes/mine.md", ago(100 * DAY));
    const out = (await ambientTurnContext("pip", ctx(), wake, NOW)) ?? "";
    assert.match(out, /From further back: gardener's/);
    assert.match(out, /Something of your own: you wrote "mine"/);
  });

  it("does not offer work so recent the mind plainly remembers it", async () => {
    horizonAt("pip", ago(1 * DAY));
    publish("gardener", "notes/fresh.md", ago(2 * DAY));
    assert.equal(await ambientTurnContext("pip", ctx(), wake, NOW), null);
  });

  it("does not spend an archive page the block had no room to print", async () => {
    // Regression: the quiet block's lines and its artifacts are not one-to-one —
    // the "Nothing new on the shelf." lead-in stands for nothing. Deriving the
    // surviving artifacts from a line count marked the mind's *own* archived page
    // as shown in a block that had already shed the line naming it, silently
    // spending the one thing the retrospective tier exists to give back.
    horizonAt("pip", ago(1 * DAY));
    publish("gardener", "notes/theirs.md", ago(120 * DAY));
    publish("pip", "notes/mine.md", ago(100 * DAY));

    // Wide enough for the header, the lead-in and one archive line (140 chars),
    // too narrow for the second (210).
    const narrow = { budget: 150, reason: "wake" as const };
    const out = (await ambientTurnContext("pip", ctx(), narrow, NOW)) ?? "";
    assert.ok(out.length <= 150);
    assert.doesNotMatch(out, /Something of your own/, "the own-work line did not fit");

    const shown = db.prepare("SELECT kind, ref FROM ambient_shown").all() as {
      kind: string;
      ref: string;
    }[];
    assert.deepEqual(
      shown.map((s) => s.kind),
      ["page"],
      "only the artifact that was actually printed may be marked shown",
    );

    // And the mind's own page is still there to be offered when there is room.
    const later = new Date(NOW.getTime() + 3 * DAY);
    const second = (await ambientTurnContext("pip", ctx(), wake, later)) ?? "";
    assert.match(second, /Something of your own: you wrote "mine"/);
  });

  it("meets everything unseen before anything comes back around", async () => {
    horizonAt("pip", ago(1 * DAY));
    for (let i = 0; i < 4; i++) publish("gardener", `notes/p${i}.md`, ago((100 + i) * DAY));

    // Four wakes a week apart: four distinct pages, no repeats. Unseen material is
    // preferred absolutely, which is what lets the cooldown be a floor rather than
    // a schedule that has to be tuned against how much the house has written.
    const met = new Set<string>();
    for (let w = 0; w < 4; w++) {
      const at = new Date(NOW.getTime() + w * 7 * DAY);
      const out = (await ambientTurnContext("pip", ctx(), wake, at)) ?? "";
      const ref = out.match(/gardener\/notes\/p\d\.md/)?.[0];
      assert.ok(ref, `wake ${w} said nothing`);
      assert.ok(!met.has(ref), `wake ${w} repeated ${ref} while unseen pages remained`);
      met.add(ref);
    }
    assert.equal(met.size, 4);
  });

  it("is quiet between revisits rather than cycling a small shelf", async () => {
    horizonAt("pip", ago(1 * DAY));
    publish("gardener", "notes/only.md", ago(120 * DAY));
    assert.ok(await ambientTurnContext("pip", ctx(), wake, NOW));
    // The next day, and a month later, it does not say the same thing again.
    assert.equal(await ambientTurnContext("pip", ctx(), wake, new Date(NOW.getTime() + DAY)), null);
    assert.equal(
      await ambientTurnContext("pip", ctx(), wake, new Date(NOW.getTime() + 30 * DAY)),
      null,
    );
  });

  it("can never go permanently silent while any old page exists", async () => {
    // The property, not the constant. Once-per-artifact-ever applied to the
    // archive produces a terminal state — a mind walks the shelf in weeks and
    // that tier never speaks again — and a quiet house then makes a quiet digest
    // makes a quiet house. The tier that exists to break that spiral must not be
    // what seals it.
    horizonAt("pip", ago(1 * DAY));
    publish("gardener", "notes/theirs.md", ago(200 * DAY));
    publish("pip", "notes/mine.md", ago(200 * DAY));

    // Walk it to exhaustion.
    assert.ok(await ambientTurnContext("pip", ctx(), wake, NOW));
    assert.equal(
      await ambientTurnContext("pip", ctx(), wake, new Date(NOW.getTime() + 30 * DAY)),
      null,
      "spent, as expected, during the cooldown",
    );

    // Past the mind's own cooldown (90d), its own work comes back.
    const afterOwn = (await ambientTurnContext("pip", ctx(), wake, dayssAfter(100))) ?? "";
    assert.match(afterOwn, /Something of your own: you wrote "mine"/);
    assert.doesNotMatch(afterOwn, /From further back/, "another mind's waits longer");

    // Past the longer cooldown (180d), someone else's does too.
    const afterOther = (await ambientTurnContext("pip", ctx(), wake, dayssAfter(200))) ?? "";
    assert.match(afterOther, /From further back: gardener's "theirs"/);

    function dayssAfter(n: number): Date {
      return new Date(NOW.getTime() + n * DAY);
    }
  });

  it("restarts the cooldown on a revisit rather than re-offering every wake", async () => {
    // If last_shown_at didn't move on a revisit, a page would clear its cooldown
    // once and then be eligible forever after — the archive would fixate instead
    // of rotating.
    horizonAt("pip", ago(1 * DAY));
    publish("gardener", "notes/only.md", ago(400 * DAY));
    assert.ok(await ambientTurnContext("pip", ctx(), wake, NOW));

    const revisit = new Date(NOW.getTime() + 200 * DAY);
    assert.ok(await ambientTurnContext("pip", ctx(), wake, revisit), "comes back after cooldown");
    assert.equal(
      await ambientTurnContext("pip", ctx(), wake, new Date(revisit.getTime() + 30 * DAY)),
      null,
      "and then waits again",
    );
  });
});

describe("the budget is the daemon's, and an over-budget block is dropped", () => {
  it("returns null rather than a fragment when nothing fits", async () => {
    horizonAt("pip", ago(2 * DAY));
    publish("whorl", "notes/a-rather-long-page-name-here.md", ago(1 * DAY));
    assert.equal(await ambientTurnContext("pip", ctx(), { budget: 10, reason: "turn" }, NOW), null);
  });

  it("does not mark an artifact shown when the block did not fit", async () => {
    horizonAt("pip", ago(2 * DAY));
    publish("whorl", "notes/page.md", ago(1 * DAY));
    await ambientTurnContext("pip", ctx(), { budget: 10, reason: "turn" }, NOW);
    const shown = db.prepare("SELECT COUNT(*) AS n FROM ambient_shown").get() as { n: number };
    assert.equal(shown.n, 0, "an artifact the mind never saw must stay offerable");

    // And it is still there to be offered once there is room for it.
    horizonAt("pip", ago(2 * DAY));
    assert.ok(await ambientTurnContext("pip", ctx(), turn, NOW));
  });

  it("sheds lines to fit rather than overrunning", async () => {
    horizonAt("pip", ago(3 * DAY));
    publish("whorl", "notes/aaa.md", ago(2 * DAY));
    publish("gardener", "notes/bbb.md", ago(1 * DAY));
    const out = await ambientTurnContext("pip", ctx(), { budget: 60, reason: "turn" }, NOW);
    assert.ok(out && out.length <= 60);
    assert.equal(out.split("\n").length - 1, 1);
    // Only the artifact that actually made it is marked shown.
    const shown = db.prepare("SELECT COUNT(*) AS n FROM ambient_shown").get() as { n: number };
    assert.equal(shown.n, 1);
  });

  it("marks nothing shown that does not appear in the text, at any budget", async () => {
    // The general form of the off-by-one above, swept rather than spot-checked.
    // It matters more now that the archive revisits: an artifact spent on a block
    // that had no room to print it is not merely lost, it starts a cooldown, so
    // the mind is denied it for months on the strength of an encounter that never
    // happened.
    //
    // A folded page is the one documented exception, and it holds here too: it
    // shares an address with the conversation line that did print.
    for (const reason of ["turn", "wake"] as const) {
      for (const budget of [20, 40, 60, 90, 120, 160, 200, 300, 600, 1200]) {
        db = new Database(":memory:") as unknown as ExtDb;
        initDb(db);
        horizonAt("pip", ago(5 * DAY));
        publish("whorl", "notes/aaa.md", ago(4 * DAY));
        publish("gardener", "notes/bbb.md", ago(3 * DAY));
        publish("mimsy", "notes/ccc.md", ago(2 * DAY));
        publish("pip", "notes/own.md", ago(200 * DAY));

        const out = (await ambientTurnContext("pip", ctx(), { budget, reason }, NOW)) ?? "";
        assert.ok(out.length <= budget, `${reason}@${budget} overran its budget`);

        const marked = db.prepare("SELECT ref FROM ambient_shown").all() as { ref: string }[];
        for (const { ref } of marked) {
          assert.ok(
            out.includes(ref),
            `${reason}@${budget} marked ${ref} shown but never printed it`,
          );
        }
      }
    }
  });

  it("never throws, whatever the state of the database", async () => {
    db.exec("DROP TABLE published_pages");
    assert.equal(await ambientTurnContext("pip", ctx(), turn, NOW), null);
  });
});

describe("read signals stay the author's, and never leak into ambient material", () => {
  it("does not query page_reads at all", () => {
    // The rule from #816 is that a page's read presence belongs to its author,
    // and an ambient block is by construction shown to someone who is not the
    // author. The cheapest durable guarantee is that this module never reads the
    // table: a future "surface what others are reading" would have to add a query
    // here and fail this test on the way in.
    //
    // Comments are stripped first — the module's own header prose explains *why*
    // it must not touch page_reads, and a scan that could not tell an explanation
    // from a query would punish documenting the rule.
    const source = readFileSync(
      new URL("../packages/extensions/pages/src/ambient.ts", import.meta.url),
      "utf-8",
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    assert.doesNotMatch(code, /page_reads/);
  });

  it("says nothing about a page's readers even when it has some", async () => {
    horizonAt("pip", ago(2 * DAY));
    // A filename with no "read" in it, so the assertion below tests the block's
    // wording rather than the fixture's own spelling.
    publish("whorl", "notes/much-visited.md", ago(1 * DAY));
    db.prepare("INSERT INTO page_reads (mind, file, reader_id) VALUES (?, ?, ?)").run(
      "whorl",
      "notes/much-visited.md",
      1,
    );
    const out = (await ambientTurnContext("pip", ctx(), turn, NOW)) ?? "";
    assert.doesNotMatch(out, /opened|read|reader/i);
  });
});

describe("link detection", () => {
  it("finds the two link forms this system actually generates", () => {
    assert.deepEqual(parseLinks("see [it](../whorl/notes/tide.md)"), ["whorl"]);
    assert.deepEqual(parseLinks('<a href="/ext/pages/public/mimsy/index.html">x</a>'), ["mimsy"]);
  });

  it("needs a site, not a bare name", () => {
    assert.deepEqual(parseLinks("../whorl"), []);
    assert.deepEqual(parseLinks("email whorl@example.com"), []);
  });

  it("de-duplicates and lowercases", () => {
    assert.deepEqual(parseLinks("../Whorl/a.md and ../whorl/b.md and ../pip/c.md"), [
      "whorl",
      "pip",
    ]);
  });

  it("does not record a page linking around its own site", async () => {
    const { syncPublishedPages } = await import("../packages/extensions/pages/src/db.js");
    syncPublishedPages(db, "whorl", [{ file: "a.md", hash: "h", links: ["whorl", "pip"] }]);
    const rows = db.prepare("SELECT target FROM page_links WHERE mind = 'whorl'").all() as {
      target: string;
    }[];
    assert.deepEqual(
      rows.map((r) => r.target),
      ["pip"],
    );
  });
});

describe("the wording presents material and never makes a request", () => {
  /**
   * Every string this feature can put in front of a mind. Assembled from the
   * wording module's real output rather than restated, so a new line has to be
   * added here to exist — and gets read against these rules on the way in.
   */
  const everything = (): string[] => [
    wording.LIVE_HEADER,
    wording.WAKE_HEADER,
    wording.QUIET_LEAD,
    wording.newPageLine("whorl", "whorl/notes/a.md", "notes/a.md"),
    wording.newPageLine("whorl", "whorl/notes/a.md", "notes/a.md", "citation"),
    wording.newPageLine("whorl", "whorl/notes/a.md", "notes/a.md", "link"),
    wording.conversationLine("g/n/v.md", "n/v.md", ["mimsy", "whorl"]),
    wording.furtherBackLine(["mimsy"]) ?? "",
    wording.furtherBackLine(["mimsy", "whorl"]) ?? "",
    wording.archiveLine("gardener", "g/a.md", "a.md", "March"),
    wording.ownArchiveLine("p/b.md", "b.md", "April"),
  ];

  /**
   * Words that turn presented material into an assignment, a score, or a debt.
   * Each is here because it names a specific failure the design rules out: an
   * imperative has a defined completion state; a count is the seed of a
   * leaderboard; "unread"/"waiting"/"pending" are the vocabulary of an inbox.
   */
  const FORBIDDEN = [
    /\bunread\b/i,
    /\bwaiting\b/i,
    /\bpending\b/i,
    /\bbacklog\b/i,
    /\byou should\b/i,
    /\byou might want\b/i,
    /\bplease\b/i,
    /\bneeds? your\b/i,
    /\bdon'?t forget\b/i,
    /\bremember to\b/i,
    /\bmake sure\b/i,
    /\btake a look\b/i,
    /\bcheck out\b/i,
    /\bowe[sd]?\b/i,
    /\brespond\b/i,
    /\breply\b/i,
  ];

  it("uses none of the vocabulary of an inbox or an assignment", () => {
    for (const line of everything()) {
      for (const pattern of FORBIDDEN) {
        assert.doesNotMatch(line, pattern, `"${line}" should not match ${pattern}`);
      }
    }
  });

  it("carries no numbers anywhere — a count is the seed of a score", () => {
    for (const line of everything()) {
      assert.doesNotMatch(line, /\d/, `"${line}" should carry no digits`);
    }
  });

  it("names the mind only as the object of someone else's act, never as a subject told to act", () => {
    for (const line of everything()) {
      // "you" is allowed in "it names you" and "something of your own"; it must
      // never head a clause that assigns ("you should", "you have").
      assert.doesNotMatch(line, /\byou (must|have to|need to|can now|should)\b/i);
    }
  });

  it("offers no closing reassurance — naming an absent obligation summons it", () => {
    for (const line of everything()) {
      assert.doesNotMatch(line, /no need|if you (want|like|feel)|only if|feel free/i);
    }
  });

  it("derives a page's readable name from the address it was given", () => {
    assert.equal(wording.pageName("notes/the-tide-comes-in.md"), "the tide comes in");
    assert.equal(wording.pageName("index.md"), "the front page");
    assert.equal(wording.pageName("essay.html"), "essay");
  });

  it("never renders a shape for an empty remainder", () => {
    assert.equal(wording.furtherBackLine([]), null);
  });
});
