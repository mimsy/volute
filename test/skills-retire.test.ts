import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq, sql } from "drizzle-orm";
import { readGlobalConfig, writeGlobalConfig } from "../packages/daemon/src/lib/config/setup.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  addMind,
  stateDir,
  voluteHome,
  voluteSystemDir,
} from "../packages/daemon/src/lib/mind/registry.js";
import { minds, sharedSkills, systemEvents } from "../packages/daemon/src/lib/schema.js";
import {
  getSharedSkill,
  importSkillFromDir,
  initDefaultSkills,
  installSkill,
  retireSharedSkill,
  retireUnshippedMindSkills,
  syncBuiltinSkills,
  syncExtensionSkills,
} from "../packages/daemon/src/lib/skills.js";
import { getCurrentVersion } from "../packages/daemon/src/lib/update-check.js";
import { exec } from "../packages/daemon/src/lib/util/exec.js";
import { createMindGitRepo } from "./helpers/git.js";

const mindName = "retire-test-mind";
const mindDir = () => join(voluteHome(), "minds", mindName);
const skillDir = (id: string) => join(mindDir(), "home", ".claude", "skills", id);
const ledgerPath = () => join(voluteSystemDir(), "skill-ledger.json");
const readLedger = () => JSON.parse(readFileSync(ledgerPath(), "utf-8"));

/** Record in the host's skill ledger that `author` shipped `id` at `versions`. */
function recordShipped(id: string, author: string, versions: string[]) {
  const ledger = existsSync(ledgerPath()) ? readLedger() : { shipped: {}, retired: {} };
  ledger.shipped[id] = { author, versions };
  writeFileSync(ledgerPath(), JSON.stringify(ledger));
}

/** A skill with a hook and a bin command, so its uninstall has shims to remove. */
function wiredSkillSource(id: string, root = join(voluteHome(), "tmp-retire-source")): string {
  const dir = join(root, id);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${id}\ndescription: retires\nmetadata:\n  bin: scripts/${id}-cmd.sh\n  hooks:\n    pre-prompt: scripts/hook.sh\n---\n\n# ${id}\n`,
  );
  writeFileSync(join(dir, "scripts", `${id}-cmd.sh`), "#!/bin/sh\necho hi\n");
  writeFileSync(join(dir, "scripts", "hook.sh"), "#!/bin/sh\n");
  return dir;
}

async function retiredNotices() {
  const db = await getDb();
  const rows = await db.select().from(systemEvents).where(eq(systemEvents.mind, mindName));
  return rows.filter((r) => JSON.parse(r.meta ?? "{}").subtype === "skill_retired");
}

/** What draining the notices into a turn does — or, with `dropped`, the next-turn cap. */
async function settleNotices(dropped = false) {
  const db = await getDb();
  await db.run(
    dropped
      ? sql`UPDATE system_events SET delivered_at = datetime('now'), meta = json_set(meta, '$.dropped', 1) WHERE mind = ${mindName}`
      : sql`UPDATE system_events SET delivered_at = datetime('now') WHERE mind = ${mindName}`,
  );
}

const handled = () => {
  const path = join(stateDir(mindName), "retired-skills.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")).handled : [];
};

const shimNames = () => [
  ...readdirSync(join(mindDir(), "home", ".local", "hooks"), { recursive: true }).map(String),
  ...(existsSync(join(mindDir(), "home", ".local", "bin"))
    ? readdirSync(join(mindDir(), "home", ".local", "bin"))
    : []),
];

async function cleanup() {
  const db = await getDb();
  await db.delete(sharedSkills);
  await db.delete(systemEvents).where(eq(systemEvents.mind, mindName));
  await db.delete(minds).where(eq(minds.name, mindName));
  for (const dir of [
    join(voluteHome(), "skills"),
    join(voluteHome(), "tmp-retire-source"),
    mindDir(),
    stateDir(mindName),
  ]) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  rmSync(ledgerPath(), { force: true });
}

describe("retiring a mind's copy of a skill Volute no longer ships (#971)", () => {
  beforeEach(async () => {
    await cleanup();
    await createMindGitRepo(mindDir());
    await addMind(mindName, 4321);
    await importSkillFromDir(wiredSkillSource("old-tool"), "volute");
    recordShipped("old-tool", "volute", ["0.0.1"]);
    await installSkill(mindName, mindDir(), "old-tool");
  });
  afterEach(cleanup);

  it("uninstalls an unmodified copy, shims and all, through the ordinary uninstall", async () => {
    assert.ok(
      shimNames().some((n) => n.includes("old-tool")),
      "the install gave shims",
    );
    assert.equal(await retireSharedSkill("old-tool", "volute"), true);
    await retireUnshippedMindSkills();

    assert.ok(!existsSync(skillDir("old-tool")));
    assert.deepEqual(
      shimNames().filter((n) => n.includes("old-tool")),
      [],
    );
    const head = await exec("git", ["log", "-1", "--format=%s"], { cwd: mindDir() });
    assert.equal(head.trim(), "Uninstall skill: old-tool");
    assert.equal((await retiredNotices()).length, 0, "an uninstalled copy needs no notice");
    assert.deepEqual(handled(), ["old-tool"]);
    await retireUnshippedMindSkills(); // a second start finds nothing to do
  });

  it("never commits what the mind had staged, or its own unstaged hook edits", async () => {
    const hook = join(mindDir(), "home", ".local", "hooks", "pre-prompt", "mine.sh");
    writeFileSync(hook, "#!/bin/sh\n");
    await exec("git", ["add", "-f", "home/.local/hooks/pre-prompt/mine.sh"], { cwd: mindDir() });
    await exec("git", ["commit", "-m", "my hook"], { cwd: mindDir() });
    writeFileSync(hook, "#!/bin/sh\necho half-written\n");
    writeFileSync(join(mindDir(), "home", "draft.md"), "half a thought\n");
    await exec("git", ["add", "-f", "home/draft.md"], { cwd: mindDir() });
    await retireSharedSkill("old-tool", "volute");
    await retireUnshippedMindSkills();

    assert.ok(!existsSync(skillDir("old-tool")));
    const committed = await exec("git", ["show", "--name-only", "--format=", "HEAD"], {
      cwd: mindDir(),
    });
    assert.ok(committed.includes("old-tool"), committed);
    assert.ok(!committed.includes("draft.md"), committed);
    assert.ok(!committed.includes("mine.sh"), committed);
    const tracked = await exec("git", ["ls-files", "home/.local"], { cwd: mindDir() });
    assert.ok(!tracked.includes("old-tool"), `the shim removals were committed: ${tracked}`);
    const staged = await exec("git", ["diff", "--cached", "--name-only"], { cwd: mindDir() });
    assert.equal(staged.trim(), "home/draft.md");
  });

  it("keeps an edited copy, and tells the mind once — counted only when it reached a turn", async () => {
    const md = join(skillDir("old-tool"), "SKILL.md");
    writeFileSync(md, `${readFileSync(md, "utf-8")}\nMy own note.\n`);
    await retireSharedSkill("old-tool", "volute");

    await retireUnshippedMindSkills();
    await retireUnshippedMindSkills();
    assert.match(readFileSync(md, "utf-8"), /My own note/);
    let notices = await retiredNotices();
    assert.equal(notices.length, 1, "a pending notice is not sent again");
    assert.equal(
      notices[0].body,
      "old-tool is no longer shipped with Volute. Your edited copy stays yours; it may call things that no longer exist.",
    );
    assert.deepEqual(handled(), [], "not told until it reached a turn");

    await settleNotices();
    await retireUnshippedMindSkills();
    await retireUnshippedMindSkills();
    notices = await retiredNotices();
    assert.equal(notices.length, 1);
    assert.deepEqual(handled(), ["old-tool"]);
    assert.ok(existsSync(md));
  });

  it("tells the mind again when the next-turn cap dropped the notice unread", async () => {
    writeFileSync(join(skillDir("old-tool"), "notes.md"), "mine\n");
    await retireSharedSkill("old-tool", "volute");
    await retireUnshippedMindSkills();
    await settleNotices(true);
    await retireUnshippedMindSkills();
    assert.equal((await retiredNotices()).length, 2);
    assert.deepEqual(handled(), []);
  });

  it("counts a notice the purge of old delivered rows removed as given", async () => {
    writeFileSync(join(skillDir("old-tool"), "notes.md"), "mine\n");
    await retireSharedSkill("old-tool", "volute");
    await retireUnshippedMindSkills();
    const db = await getDb();
    await db.delete(systemEvents).where(eq(systemEvents.mind, mindName));
    await retireUnshippedMindSkills();
    assert.equal((await retiredNotices()).length, 0);
    assert.deepEqual(handled(), ["old-tool"]);
  });

  it("tells the mind afresh when a skill that shipped again is retired again", async () => {
    writeFileSync(join(skillDir("old-tool"), "notes.md"), "mine\n");
    await retireSharedSkill("old-tool", "volute");
    await retireUnshippedMindSkills();
    await settleNotices();
    await retireUnshippedMindSkills();
    assert.deepEqual(handled(), ["old-tool"]);

    await importSkillFromDir(wiredSkillSource("old-tool"), "volute");
    recordShipped("old-tool", "volute", ["0.0.1"]);
    await retireUnshippedMindSkills();
    assert.deepEqual(handled(), []);
    assert.equal(await retireSharedSkill("old-tool", "volute"), true);
    await retireUnshippedMindSkills();
    assert.equal((await retiredNotices()).length, 2);
  });

  it("waits out a merge in progress rather than commit into it", async () => {
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: mindDir() })).trim();
    writeFileSync(join(mindDir(), ".git", "MERGE_HEAD"), `${head}\n`);
    await retireSharedSkill("old-tool", "volute");
    await retireUnshippedMindSkills();
    assert.ok(existsSync(join(skillDir("old-tool"), "SKILL.md")), "nothing removed mid-merge");
    assert.ok(shimNames().some((n) => n.includes("old-tool")));
    assert.deepEqual(handled(), []);

    rmSync(join(mindDir(), ".git", "MERGE_HEAD"));
    await retireUnshippedMindSkills();
    assert.ok(!existsSync(skillDir("old-tool")));
  });

  it("treats a deleted file as an edit", async () => {
    rmSync(join(skillDir("old-tool"), "scripts", "hook.sh"));
    await retireSharedSkill("old-tool", "volute");
    await retireUnshippedMindSkills();
    assert.ok(existsSync(skillDir("old-tool")));
    assert.equal((await retiredNotices()).length, 1);
  });

  it("treats an edited shim as an edit", async () => {
    const shim = join(mindDir(), "home", ".local", "bin", "old-tool-cmd");
    writeFileSync(shim, `${readFileSync(shim, "utf-8")}# mine\n`);
    await retireSharedSkill("old-tool", "volute");
    await retireUnshippedMindSkills();
    assert.ok(existsSync(skillDir("old-tool")));
    assert.ok(existsSync(shim));
    assert.equal((await retiredNotices()).length, 1);
  });

  it("treats a shim the mind deleted as an edit", async () => {
    rmSync(join(mindDir(), "home", ".local", "bin", "old-tool-cmd"));
    await retireSharedSkill("old-tool", "volute");
    await retireUnshippedMindSkills();
    assert.ok(existsSync(skillDir("old-tool")));
    assert.equal((await retiredNotices()).length, 1);
  });

  it("keeps a copy it can't vouch for, saying so", async () => {
    // What an older daemon left: no copy of the shipped version anywhere in the repo.
    const refs = await exec("git", ["for-each-ref", "--format=%(refname)", "refs/volute/"], {
      cwd: mindDir(),
    });
    for (const ref of refs.trim().split("\n").filter(Boolean)) {
      await exec("git", ["update-ref", "-d", ref], { cwd: mindDir() });
    }
    const upstreamPath = join(skillDir("old-tool"), ".upstream.json");
    const upstream = JSON.parse(readFileSync(upstreamPath, "utf-8"));
    writeFileSync(upstreamPath, JSON.stringify({ ...upstream, baseCommit: "0".repeat(40) }));
    await retireSharedSkill("old-tool", "volute");

    await retireUnshippedMindSkills();
    assert.ok(existsSync(skillDir("old-tool")));
    const notices = await retiredNotices();
    assert.equal(notices.length, 1);
    assert.match(notices[0].body ?? "", /couldn't confirm your copy is unchanged/);
  });

  it("leaves a copy alone whose pool entry was merely deleted, not retired", async () => {
    const db = await getDb();
    await db.delete(sharedSkills).where(eq(sharedSkills.id, "old-tool"));
    await retireUnshippedMindSkills();
    assert.ok(existsSync(skillDir("old-tool")));
    assert.equal((await retiredNotices()).length, 0);
  });

  it("forgets a retirement when the skill ships again", async () => {
    await retireSharedSkill("old-tool", "volute");
    await importSkillFromDir(wiredSkillSource("old-tool"), "volute");
    await retireUnshippedMindSkills();
    assert.ok(existsSync(skillDir("old-tool")));
    assert.deepEqual(readLedger().retired, {});
  });

  it("retires only a pool row under the author the ledger says shipped it", async () => {
    assert.equal(await retireSharedSkill("old-tool", "ext:pages"), false);
    recordShipped("old-tool", "ext:pages", ["0.0.1", "0.0.1"]);
    assert.equal(await retireSharedSkill("old-tool", "volute"), false);
    assert.equal(await retireSharedSkill("missing", "volute"), false);
    assert.ok(await getSharedSkill("old-tool"));
    assert.deepEqual(readLedger().retired, {});
  });
});

describe("syncBuiltinSkills retires built-ins it no longer ships (#971)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("retires a built-in an earlier Volute shipped, from the pool and the default skills", async () => {
    await importSkillFromDir(wiredSkillSource("gone-builtin"), "volute");
    recordShipped("gone-builtin", "volute", ["0.0.1"]);
    writeGlobalConfig({ ...readGlobalConfig(), defaultSkills: ["memory", "gone-builtin"] });

    await syncBuiltinSkills();
    await initDefaultSkills();

    assert.equal(await getSharedSkill("gone-builtin"), undefined);
    assert.ok(!existsSync(join(voluteHome(), "skills", "gone-builtin")));
    assert.ok(!readGlobalConfig().defaultSkills?.includes("gone-builtin"));
    const ledger = readLedger();
    assert.deepEqual(ledger.retired, { "gone-builtin": { author: "volute" } });
    assert.deepEqual(ledger.shipped.memory, { author: "volute", versions: [getCurrentVersion()] });
    assert.ok(await getSharedSkill("memory"), "shipped built-ins stay");
  });

  it("never retires on a downgrade, or at the version that last shipped it", async () => {
    await importSkillFromDir(wiredSkillSource("gone-builtin"), "volute");
    for (const version of ["999.0.0", getCurrentVersion()]) {
      recordShipped("gone-builtin", "volute", [version]);
      await syncBuiltinSkills();
      assert.ok(await getSharedSkill("gone-builtin"), `kept at ${version}`);
      assert.deepEqual(readLedger().shipped["gone-builtin"].versions, [version]);
    }
  });

  it("never retires a later skill under a retired built-in's id — the spirit's, say", async () => {
    await importSkillFromDir(wiredSkillSource("gone-builtin"), "volute");
    recordShipped("gone-builtin", "volute", ["0.0.1"]);
    await syncBuiltinSkills();
    assert.equal(await getSharedSkill("gone-builtin"), undefined);

    await importSkillFromDir(wiredSkillSource("gone-builtin"), "volute"); // the spirit publishes
    await syncBuiltinSkills();
    assert.ok(await getSharedSkill("gone-builtin"));
  });

  it("never retires without the ledger's word: no record, or the spirit's own 'volute' skill", async () => {
    await importSkillFromDir(wiredSkillSource("spirit-own"), "volute");
    await syncBuiltinSkills();
    assert.ok(await getSharedSkill("spirit-own"));
    assert.deepEqual(readLedger().retired, {});
  });
});

describe("syncExtensionSkills retires skills an extension stops shipping (#971)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  const extSkills = () => join(voluteHome(), "tmp-retire-source", "ext");

  it("retires its own dropped skill once its versions move past, and nothing else", async () => {
    wiredSkillSource("kept", extSkills());
    wiredSkillSource("dropped", extSkills());
    await importSkillFromDir(wiredSkillSource("other-ext"), "ext:other");
    await syncExtensionSkills("fake", "1.0.0", extSkills());
    assert.ok(await getSharedSkill("dropped"));

    rmSync(join(extSkills(), "dropped"), { recursive: true });
    await syncExtensionSkills("fake", "1.0.0", extSkills());
    assert.ok(await getSharedSkill("dropped"), "the same versions are not past");

    await syncExtensionSkills("fake", "1.1.0", extSkills());
    assert.equal(await getSharedSkill("dropped"), undefined);
    assert.ok(await getSharedSkill("kept"));
    assert.ok(await getSharedSkill("other-ext"), "another extension's skill is not this one's");
    assert.deepEqual(readLedger().retired, { dropped: { author: "ext:fake" } });
  });

  it("ends a retirement when the skill ships again, even if its import fails", async () => {
    wiredSkillSource("back", extSkills());
    const ledger = { shipped: {}, retired: { back: { author: "ext:fake" } } };
    writeFileSync(ledgerPath(), JSON.stringify(ledger));
    // Held by another extension: the import refuses.
    await importSkillFromDir(wiredSkillSource("back"), "ext:other");
    await syncExtensionSkills("fake", "1.0.0", extSkills());
    assert.equal((await getSharedSkill("back"))?.author, "ext:other");
    assert.deepEqual(readLedger().retired, {});
  });

  it("retires nothing when its skills dir can't be read", async () => {
    wiredSkillSource("kept", extSkills());
    await syncExtensionSkills("fake", "1.0.0", extSkills());
    rmSync(extSkills(), { recursive: true });
    await syncExtensionSkills("fake", "2.0.0", extSkills());
    assert.ok(await getSharedSkill("kept"));
  });
});
