import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { getSpiritName } from "../packages/daemon/src/lib/config/setup.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { addMind, mindDir } from "../packages/daemon/src/lib/mind/registry.js";
import { minds, systemEvents } from "../packages/daemon/src/lib/schema.js";
import {
  findMindsWithStaleApiPaths,
  findStaleApiPathsIn,
  reportStaleApiPaths,
  resetStaleApiNotifications,
  staleApiPathsMessage,
} from "../packages/daemon/src/lib/template/stale-api-paths.js";

/** Build a mind directory on disk with the given hook/daemon-client contents. */
function fixtureMind(dir: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const path = resolve(dir, rel);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
}

const CURRENT_HOOK = `fetch(\`http://127.0.0.1:\${p}/api/v1/minds/\${m}/history/notices\`);\n`;
const PRE_0_58_HOOK = `fetch(\`http://127.0.0.1:\${p}/api/minds/\${m}/history/notices\`);\n`;
const PRE_0_58_DOCS = `fetch(\`http://127.0.0.1:\${p}/api/extensions/mind-docs\`);\n`;

describe("findStaleApiPathsIn", () => {
  it("finds hooks still calling the removed /api/minds/ prefix", async () => {
    const dir = resolve(mindDir("scan-stale"));
    fixtureMind(dir, {
      "home/.local/hooks/pre-prompt/notices.ts": PRE_0_58_HOOK,
      "home/.local/hooks/pre-prompt/session-activity.ts": CURRENT_HOOK,
    });

    assert.deepEqual(await findStaleApiPathsIn(dir), ["home/.local/hooks/pre-prompt/notices.ts"]);
  });

  it("finds the removed /api/extensions/ prefix too", async () => {
    // The pre-#900 startup-context.ts fetched mind-docs from /api/extensions/.
    // A mind whose startup context silently comes back empty is just as cut off.
    const dir = resolve(mindDir("scan-ext"));
    fixtureMind(dir, { "home/.local/hooks/startup-context.ts": PRE_0_58_DOCS });

    assert.deepEqual(await findStaleApiPathsIn(dir), ["home/.local/hooks/startup-context.ts"]);
  });

  it("finds a stale src/lib/daemon-client.ts", async () => {
    // mimsy's failure on bardo: her mind server POSTed every event to
    // /api/minds/mimsy/events and 404'd 26,462 times in fourteen days.
    const dir = resolve(mindDir("scan-client"));
    fixtureMind(dir, {
      "src/lib/daemon-client.ts": `const url = \`http://127.0.0.1:\${p}/api/minds/\${m}/events\`;\n`,
    });

    assert.deepEqual(await findStaleApiPathsIn(dir), ["src/lib/daemon-client.ts"]);
  });

  it("does not flag a current mind", async () => {
    const dir = resolve(mindDir("scan-clean"));
    fixtureMind(dir, {
      "home/.local/hooks/pre-prompt/notices.ts": CURRENT_HOOK,
      "src/lib/daemon-client.ts": CURRENT_HOOK,
    });

    assert.deepEqual(await findStaleApiPathsIn(dir), []);
  });

  it("does not mistake /api/v1/minds/ for /api/minds/", async () => {
    // The substring check only works because the v1 path doesn't contain the
    // bare one. If that ever stopped being true every healthy mind would be flagged.
    assert.ok(!"/api/v1/minds/x".includes("/api/minds/"));
    assert.ok(!"/api/v1/extensions/x".includes("/api/extensions/"));
  });

  it("recurses into nested hook directories", async () => {
    const dir = resolve(mindDir("scan-nested"));
    fixtureMind(dir, { "home/.local/hooks/post-tool-use/deep/thing.ts": PRE_0_58_HOOK });

    assert.deepEqual(await findStaleApiPathsIn(dir), [
      "home/.local/hooks/post-tool-use/deep/thing.ts",
    ]);
  });

  it("finds an installed skill copy with a stale path", async () => {
    // Skills are *copied* into the mind at install time and tracked for updates
    // independently, so fixing a path in the shared pool never reaches an
    // already-installed copy. imagegen shipped with /api/minds/…/imagegen/jobs
    // and has been dead for every mind since 0.58.0 for exactly that reason.
    const dir = resolve(mindDir("scan-skill"));
    fixtureMind(dir, {
      "home/.claude/skills/imagegen/scripts/imagegen.ts": `fetch(\`\${base}/api/minds/\${m}/imagegen/jobs\`);\n`,
    });

    assert.deepEqual(await findStaleApiPathsIn(dir), [
      "home/.claude/skills/imagegen/scripts/imagegen.ts",
    ]);
  });

  it("returns nothing for a directory that isn't there", async () => {
    assert.deepEqual(await findStaleApiPathsIn(resolve(mindDir("scan-absent"))), []);
  });
});

describe("findMindsWithStaleApiPaths", () => {
  beforeEach(async () => {
    const db = await getDb();
    await db.delete(minds);
    resetStaleApiNotifications();
  });

  it("reports each registered mind that is affected, and only those", async () => {
    await addMind("broken", 4801);
    await addMind("healthy", 4802);
    fixtureMind(mindDir("broken"), {
      "home/.local/hooks/pre-prompt/notices.ts": PRE_0_58_HOOK,
      "home/.local/hooks/pre-prompt/turn-context.ts": PRE_0_58_HOOK,
    });
    fixtureMind(mindDir("healthy"), {
      "home/.local/hooks/pre-prompt/notices.ts": CURRENT_HOOK,
    });

    const stale = await findMindsWithStaleApiPaths();

    assert.deepEqual(
      stale.map((s) => s.mind),
      ["broken"],
    );
    assert.deepEqual(stale[0].files, [
      "home/.local/hooks/pre-prompt/notices.ts",
      "home/.local/hooks/pre-prompt/turn-context.ts",
    ]);
  });

  it("covers the spirit, whose directory lives outside the minds dir", async () => {
    // The spirit was stranded on bardo exactly like the minds were (505 × 404 in
    // fourteen days). Its registry row carries a custom `dir`; scanning
    // mindDir(name) alone would silently skip it.
    const db = await getDb();
    const dir = resolve(mindDir("__spirit-home"));
    await db.insert(minds).values({
      name: "volute",
      port: 4899,
      mind_type: "spirit",
      stage: "sprouted",
      dir,
    });
    fixtureMind(dir, { "home/.local/hooks/pre-prompt/notices.ts": PRE_0_58_HOOK });

    const stale = await findMindsWithStaleApiPaths();

    assert.deepEqual(
      stale.map((s) => s.mind),
      ["volute"],
    );
  });

  it("reports nothing when every mind is current", async () => {
    await addMind("fine", 4803);
    fixtureMind(mindDir("fine"), {
      "home/.local/hooks/pre-prompt/notices.ts": CURRENT_HOOK,
    });

    assert.deepEqual(await findMindsWithStaleApiPaths(), []);
  });
});

describe("staleApiPathsMessage", () => {
  it("names the files and tells the mind what it has been missing", () => {
    const body = staleApiPathsMessage(["home/.local/hooks/pre-prompt/notices.ts"], "pip");

    assert.match(body, /home\/\.local\/hooks\/pre-prompt\/notices\.ts/);
    assert.match(body, /notices are piling up undelivered/);
    // The advice must be true in both directions. Telling a mind to run upgrade
    // when upgrade cannot touch its edited hook is how this went unfixed for
    // fifteen days on the production host.
    assert.match(body, /volute mind upgrade/);
    assert.match(body, /If you have edited one/);
    assert.match(body, /\/api\/v1\/minds\//);
  });

  it("never tells the spirit to run `volute mind upgrade` — it 404s on the spirit", () => {
    // `volute mind upgrade` checks existsSync(mindDir(name)); the spirit lives
    // under voluteSystemDir(), so the command simply doesn't apply to it.
    // Handing it advice that cannot work would repeat the original bug: a
    // recommendation that sounds actionable and isn't.
    const body = staleApiPathsMessage(["home/.local/hooks/pre-prompt/notices.ts"], getSpiritName());

    assert.doesNotMatch(body, /Run `volute mind upgrade`/);
    assert.match(body, /restarting the daemon/i);
    assert.match(body, /does not apply to you/);
  });

  it("does not blame the mind for the silence", () => {
    const body = staleApiPathsMessage(["x.ts"], "pip");
    assert.match(body, /You have not been ignoring them/);
  });
});

describe("reportStaleApiPaths", () => {
  beforeEach(async () => {
    const db = await getDb();
    await db.delete(minds);
    await db.delete(systemEvents);
    resetStaleApiNotifications();
  });

  async function eventsFor(mind: string) {
    const db = await getDb();
    return db.select().from(systemEvents).where(eq(systemEvents.mind, mind));
  }

  it("tells an affected mind once, not once per hourly sweep", async () => {
    // The event is a message inside the mind's own context window. The condition
    // is static — it can't clear itself between sweeps — so repeating it hourly
    // would spend the mind's attention on something it already knows.
    await addMind("noisy", 4811);
    fixtureMind(mindDir("noisy"), {
      "home/.local/hooks/pre-prompt/notices.ts": PRE_0_58_HOOK,
    });

    await reportStaleApiPaths();
    const afterFirst = await eventsFor("noisy");
    assert.equal(afterFirst.length, 1, "the mind must be told");
    assert.match(afterFirst[0].body, /notices are piling up undelivered/);
    assert.equal(afterFirst[0].delivery, "immediate", "a next-turn notice would be stranded too");

    await reportStaleApiPaths();
    await reportStaleApiPaths();
    assert.equal((await eventsFor("noisy")).length, 1, "later sweeps must not repeat it");
  });

  it("tells the spirit about each affected mind", async () => {
    await addMind("quiet", 4812);
    fixtureMind(mindDir("quiet"), {
      "home/.local/hooks/pre-prompt/notices.ts": PRE_0_58_HOOK,
    });

    await reportStaleApiPaths();

    const spiritEvents = await eventsFor(getSpiritName());
    assert.equal(spiritEvents.length, 1);
    assert.match(spiritEvents[0].body, /quiet is running Volute hooks/);
    assert.equal(spiritEvents[0].delivery, "next-turn");
  });

  it("says nothing at all when every mind is current", async () => {
    await addMind("ok", 4813);
    fixtureMind(mindDir("ok"), { "home/.local/hooks/pre-prompt/notices.ts": CURRENT_HOOK });

    await reportStaleApiPaths();

    const db = await getDb();
    assert.deepEqual(await db.select().from(systemEvents), []);
  });
});
